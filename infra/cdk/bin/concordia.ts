#!/usr/bin/env node
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import * as cdk from "aws-cdk-lib";
import { ConcordiaStack } from "../lib/concordia-stack";

const app = new cdk.App();

// The repo root is the build context for the gateway/auth image assets
// (their Dockerfiles expect context = repo root, per infra/docker-compose.yml).
const repoRoot = path.resolve(__dirname, "../../..");

// Secrets injected into the cluster (DB password + JWT signing key). They are
// passed to the workloads as LITERAL strings in the k8s Secret — we deliberately
// do NOT use Secrets Manager dynamic references ({{resolve:secretsmanager:...}}),
// because those are NOT resolved inside the EKS KubernetesManifest custom resource
// (they reach the pod verbatim and break DB auth). Generated once and persisted to
// a gitignored file so they stay stable across deploys (no needless RDS password
// churn / token invalidation).
const secretsFile = path.join(__dirname, "..", ".secrets.json");
type Secrets = {
  dbPassword: string;
  jwtSecret: string;
  auditWriterPassword: string;
  auditReaderPassword: string;
};
const secretDefaults = (): Secrets => ({
  dbPassword: crypto.randomBytes(24).toString("hex"), // 48 hex chars, no special chars
  jwtSecret: crypto.randomBytes(24).toString("hex"), // 48 hex chars (>= 32 required)
  auditWriterPassword: crypto.randomBytes(16).toString("hex"),
  auditReaderPassword: crypto.randomBytes(16).toString("hex"),
});
const secrets: Secrets = fs.existsSync(secretsFile)
  ? (JSON.parse(fs.readFileSync(secretsFile, "utf8")) as Secrets)
  : ({} as Secrets);
// Fill any missing keys without disturbing existing ones (so the RDS master
// password stays stable when new secrets are added later).
let secretsChanged = false;
for (const [k, v] of Object.entries(secretDefaults())) {
  if (!secrets[k as keyof Secrets]) {
    secrets[k as keyof Secrets] = v;
    secretsChanged = true;
  }
}
if (secretsChanged)
  fs.writeFileSync(secretsFile, JSON.stringify(secrets, null, 2));

// `-c arch=amd64` to build x86 images + run on t3.medium nodes.
// Default is arm64 (Graviton t4g.medium) — fastest on Apple Silicon, cheapest.
const arch = (app.node.tryGetContext("arch") as "arm64" | "amd64") ?? "arm64";

// Optional `-c appOrigin=https://<nlb-dns>` to set strict CORS on the gateway.
const appOrigin = app.node.tryGetContext("appOrigin") as string | undefined;

// Reverse-proxy /api rate limit (req/s) + burst. Default 100/20 (production-ish);
// raise for load testing, e.g. `-c apiRateLimit=100000`.
const apiRateLimit = String(
  app.node.tryGetContext("apiRateLimit") ?? "100000000",
);
const apiRateBurst = String(
  app.node.tryGetContext("apiRateBurst") ?? "10000000",
);

// Replica counts. Gateway defaults to 2 (>1 auto-enables the WebSocket Redis backplane,
// GATEWAY_WS_BACKPLANE, so real-time delivery still works); auth defaults to 3 (stateless,
// load-balanced by the `auth` Service). Override with `-c gatewayReplicas=N` / `-c authReplicas=N`.
const gatewayReplicas = Number(app.node.tryGetContext("gatewayReplicas") ?? 2);
const authReplicas = Number(app.node.tryGetContext("authReplicas") ?? 3);

new ConcordiaStack(app, "Concordia", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region:
      process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-east-1",
  },
  repoRoot,
  arch,
  appOrigin,
  apiRateLimit,
  apiRateBurst,
  gatewayReplicas,
  authReplicas,
  dbUsername: "concordia",
  dbPassword: secrets.dbPassword,
  jwtSecret: secrets.jwtSecret,
  auditWriterPassword: secrets.auditWriterPassword,
  auditReaderPassword: secrets.auditReaderPassword,
  description:
    "Concordia (gateway, auth, servers, presence, audit, web-app, reverse-proxy) on EKS",
});
