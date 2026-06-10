# Concordia on AWS (CDK)

Deploys the **core subset** of Concordia — `gateway`, `auth`, `web-app`, `reverse-proxy` —
to **EKS**, backed by **managed data** (RDS Postgres, ElastiCache Redis, MSK Kafka). The
reverse proxy is the sole public ingress, exposed via an **internet-facing NLB** and
terminating TLS with the repo's existing **self-signed certs**.

Everything comes up with a single `cdk deploy` — no GitHub/CodePipeline. Container images are
built locally from the existing Dockerfiles and pushed to ECR automatically as part of the deploy.

```
Internet → NLB (:80/:443) → reverse-proxy (Nginx, TLS)
                               ├─ /api → gateway (:8080) → auth (:8081) → RDS Postgres
                               │            └─ Redis (rate-limit), MSK (audit events)
                               └─ /    → web-app (Next.js :3000)
```

> **Architecture note.** This is one CloudFormation stack (`Concordia`) composed of three
> construct layers — Network (VPC) → Data (RDS/Redis/MSK) → Cluster (EKS + workloads). One
> stack keeps `cdk deploy` simple and sidesteps cross-stack VPC/EKS subnet-tagging issues.

## ⚠️ Cost & time

You picked the heavy options. Rough monthly cost if left running:

| Resource | ~Cost/mo |
|---|---|
| EKS control plane | ~$72 |
| 2 × `t4g.medium` nodes | ~$50 |
| MSK 2 × `kafka.t3.small` + storage | ~$80–100 |
| RDS `db.t3.micro` | ~$15 |
| ElastiCache `cache.t3.micro` | ~$12 |
| NLB + 1 NAT gateway | ~$35 |
| **Total** | **~$270–290** |

First deploy takes **~30–40 min** (EKS ~15 min, MSK ~25 min, in parallel-ish). **Run
`cdk destroy` when you're done** to stop billing.

## Prerequisites (what you must configure / log in to)

1. **AWS credentials** with admin-ish permissions:
   ```bash
   aws configure          # or: aws sso login --profile <profile>
   aws sts get-caller-identity   # confirm you're logged in
   ```
2. **Region & account** (CDK reads these from your environment):
   ```bash
   export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
   export CDK_DEFAULT_REGION=us-east-1     # or your preferred region
   ```
3. **Docker Desktop running** — the deploy builds the 4 images locally to push to ECR.
4. **Node 20+** and this project's deps:
   ```bash
   cd infra/cdk && npm install
   ```
5. **Self-signed certs present** at `infra/certs/server.crt` / `server.key` (already in the
   repo; regenerate with the repo's existing cert tooling if missing).
6. **One-time CDK bootstrap** (per account/region):
   ```bash
   npx cdk bootstrap aws://$CDK_DEFAULT_ACCOUNT/$CDK_DEFAULT_REGION
   ```
7. *(Optional)* **kubectl** to inspect the cluster after deploy (command is printed as a
   stack output).

No GitHub secrets / OIDC are needed — this is purely local `cdk deploy`.

## Deploy

```bash
cd infra/cdk
npx cdk deploy
```

When it finishes, note the **`AppUrl`** output (the public `https://<nlb-dns>` URL) and the
**`KubeconfigCommand`** output.

### Architecture flag

The default builds **arm64** images and runs them on **Graviton (`t4g.medium`)** nodes — this
is fastest on Apple Silicon and cheapest. To build x86 images on `t3.medium` instead:

```bash
npx cdk deploy -c arch=amd64
```

(On Apple Silicon, `arch=amd64` cross-builds under emulation and is **much** slower — only use
it if you specifically need x86.)

### Strict CORS (optional)

Browser traffic is same-origin through the NLB, so CORS isn't required. If you want the gateway
to allowlist the public origin explicitly, deploy once, read `AppUrl`, then redeploy:

```bash
npx cdk deploy -c appOrigin=https://<nlb-dns>
```

## Verify

```bash
# 1. Point kubectl at the cluster (use the KubeconfigCommand output)
aws eks update-kubeconfig --name concordia --region $CDK_DEFAULT_REGION

# 2. All pods Running
kubectl get pods -n concordia

# 3. Health through the public NLB (self-signed → -k)
curl -k https://<nlb-dns>/health

# 4. Login path reaches auth → RDS (4xx + an auth response header proves the chain)
curl -k -i -X POST https://<nlb-dns>/api/auth/login \
  -H 'Content-Type: application/json' -d '{}'

# 5. Open https://<nlb-dns>/ in a browser (accept the cert warning), register + log in.
```

## Tear down

```bash
npx cdk destroy
```

RDS, Redis and MSK are configured with `removalPolicy: DESTROY` / no final snapshot for clean
lab teardown — **all data is deleted**.

## Notes & known limitations

- **MSK is PLAINTEXT in-VPC** (port 9092, unauthenticated) so the Go/Spring Kafka clients work
  unchanged. Security comes from VPC isolation + security groups, not broker auth. Don't reuse
  this for anything internet-exposed.
- **web-app runs as a Next.js server** (`apps/web-app/Dockerfile.prod` → `next build` with
  `NEXT_OUTPUT=server` → `next start`). A server (not static export) is required so dynamic
  routes like `/servers/<id>/channels/<cid>` render on demand — static export only pre-renders
  the `default` id from `generateStaticParams()` and hard-reloads real IDs to the root page.
  This matches the app's documented SSR design; static export stays reserved for the Electron
  desktop build. No dev server / no HMR websocket. The local `docker-compose` dev workflow still
  uses the original `apps/web-app/Dockerfile` (`next dev`, hot-reload) and is unaffected.
- **Deferred to a later iteration** (not in this deploy): chat (Cassandra/Keyspaces + S3),
  voice, tips, presence, audit, the gRPC permission path, autoscaling/HPA, ACM/custom domain.
- A new `apps/web-app/.dockerignore` was added so the image asset doesn't copy `.next` /
  `node_modules` (kept the build small and correct).
