# Concordia — AWS Deployment Summary

How the whole Concordia stack runs on AWS, what was provisioned, and the key
decisions/fixes made along the way. The infrastructure-as-code lives in
[`infra/cdk/`](../infra/cdk/) (a single CDK app); operational runbook is
[`infra/cdk/README.md`](../infra/cdk/README.md).

- **Account / region:** `537090272317` / `us-east-1`
- **Public URL:** `https://a293b3217eada44bc8e4a58885577dea-be5f3b9a4b974f65.elb.us-east-1.amazonaws.com` (self-signed cert → browser warning)
- **Compute:** EKS (Kubernetes 1.31), 3× Graviton nodes
- **Deploy method:** local `cdk deploy` (no CI/CD), images built locally → ECR

---

## 1. Architecture at a glance

```
                 Internet
                    │  https / 443 (self-signed TLS)
                    ▼
          ┌──────────────────┐   AWS Network Load Balancer (NLB)
          │   reverse-proxy   │   (k8s Service type=LoadBalancer)
          │  (nginx, public)  │
          └─────────┬─────────┘
            /api,/ws │  /         (URL routing, TLS termination)
        ┌────────────┴───────────┐
        ▼                        ▼
   ┌──────────┐            ┌────────────┐
   │ gateway  │            │  web-app   │  Next.js server (SSR)
   │ (Go,JWT) │            │ (next start)│
   └────┬─────┘            └────────────┘
        │  validates JWT, forwards X-User-ID, proxies by path
        ├──► auth      (Java)   ── RDS: auth_db        + Kafka(user-registered)
        ├──► servers   (Java)   ── RDS: servers_db     + gRPC PermService :50051
        ├──► chat      (Rust)   ── Cassandra(discord_chat) + Kafka + gRPC→servers
        ├──► voice     (Python) ── ElastiCache Redis   + gRPC→servers
        ├──► presence  (Go)     ── ElastiCache Redis
        └──► (audit)   (Go)     ── consumes Kafka audit.events → RDS: audit (append-only)

   Managed data plane (all private, VPC-only):
     RDS Postgres 16 · ElastiCache Redis · MSK Kafka · (Cassandra self-hosted in-cluster)
```

**Single public ingress:** only the `reverse-proxy` is internet-facing (via the NLB).
Everything else is `ClusterIP` (cluster-internal) — the same "single public component"
model as the local docker-compose stack.

---

## 2. AWS resources (CDK-provisioned)

| Resource | What | Identifier / notes |
|---|---|---|
| **VPC** | 2 AZs, public + private-with-egress subnets, 1 NAT gateway | `10.0.0.0/16` |
| **EKS cluster** | Kubernetes 1.31, OIDC provider, auth mode `API_AND_CONFIG_MAP` | `concordia` |
| **Node group** | 3× `t4g.medium` (Graviton / arm64), AL2023 | min 2 / desired 3 / max 4 |
| **EBS CSI driver** | EKS managed addon (`v1.61.x`) for persistent volumes, via **IRSA** | needed for Cassandra |
| **RDS Postgres 16** | `db.t3.micro`, single-AZ, no backups (lab) | `concordia-datapostgres…us-east-1.rds.amazonaws.com` |
| **ElastiCache Redis** | `cache.t3.micro`, single node, in-VPC (no auth/TLS) | `con-da-…use1.cache.amazonaws.com:6379` |
| **MSK (Kafka)** | 2× `kafka.t3.small`, **PLAINTEXT** in-VPC listener (9092) | `b-1/b-2.concordia.…kafka.us-east-1.amazonaws.com:9092` |
| **NLB** | internet-facing, L4, created by the reverse-proxy Service | the public URL above |
| **ECR** | holds the 9 locally-built service images | CDK asset repos |

> RDS hosts **3 logical databases** in one instance: `auth_db`, `servers_db`, and the
> append-only `audit` DB (with INSERT-only `audit_writer` / read-only `audit_reader` roles).

---

## 3. EKS nodes

| Node | Instance | Zone |
|---|---|---|
| `ip-10-0-2-105` | t4g.medium | us-east-1a |
| `ip-10-0-2-86`  | t4g.medium | us-east-1a |
| `ip-10-0-3-249` | t4g.medium | us-east-1b |

Graviton (arm64) was chosen so image builds are **native on Apple Silicon** (fast) and
cheaper. (`-c arch=amd64` switches to x86/`t3.medium` if ever needed.)

---

## 4. Workloads (namespace `concordia`)

| Pod / Service | Lang | Port(s) | Backing store | Public? |
|---|---|---|---|---|
| `reverse-proxy` | nginx | 80, 443 (NLB) | — | **yes** (ingress) |
| `web-app` | Next.js | 3000 | — (calls gateway via browser) | via proxy `/` |
| `gateway` | Go | 8080 | Redis (rate-limit), Kafka (audit) | via proxy `/api`,`/ws` |
| `auth` | Java/Spring | 8081 | RDS `auth_db`, Kafka | internal |
| `servers` | Java/Spring | 8082 + **50051 gRPC** | RDS `servers_db`, Kafka | internal |
| `chat` | Rust/Axum | 8083 | **Cassandra** `discord_chat`, Kafka, gRPC→servers | internal |
| `voice` | Python/FastAPI | 8084 | Redis, gRPC→servers | internal |
| `presence` | Go | 8086 | Redis | internal |
| `audit` | Go | 8087 | RDS `audit` (append-only), Kafka consumer | internal |
| `cassandra-0` | Cassandra 4 | 9042 | **EBS gp3 10Gi** (`data-cassandra-0` PVC) | internal (StatefulSet) |

Default replica counts: **`auth` = 3**, **`gateway` = 2** (both balanced by their Service);
everything else is 1. The gateway can be replicated because the Redis pub/sub **backplane**
is auto-enabled at >1 replica (see [§10](#10-horizontal-scaling--config-knobs)); otherwise its
in-memory WebSocket state would make `/internal/push` undeliverable across pods.

### One-shot init Jobs (the cloud equivalent of compose's `*-init` containers)
| Job | Does |
|---|---|
| `kafka-topic-init` | creates MSK topics `user-registered`, `message-created`, `mention`, `audit.events` |
| `db-init` | creates `servers_db` + the `audit` DB, table, and INSERT-only roles on RDS |
| `cassandra-init` | creates the `discord_chat` keyspace once Cassandra is reachable |

---

## 5. How it gets deployed

- **One CDK stack** (`Concordia`, TypeScript) composed of 3 construct layers:
  `NetworkConstruct` (VPC) → `DataConstruct` (RDS/Redis/MSK) → `ClusterConstruct`
  (EKS + all k8s manifests). One stack avoids cross-stack VPC/EKS pitfalls and means a
  single `cdk deploy`.
- **Images** are built locally from the existing Dockerfiles via CDK `DockerImageAsset`
  and pushed to ECR during deploy — no registry pipeline. Build contexts mirror
  `infra/docker-compose.yml` (gateway/auth/servers/chat/audit/voice build from repo
  root; web-app/reverse-proxy from their own dirs).
- **Secrets** (DB password, JWT key, audit role passwords) are generated once into a
  gitignored `infra/cdk/.secrets.json` and injected as **literal** values into a k8s
  Secret (see gotcha #1). RDS uses the same literal password.
- **k8s manifests** (Deployments, Services, StatefulSet, Jobs, Secret, StorageClass) are
  applied by the CDK EKS `KubernetesManifest` custom resource.

```bash
cd infra/cdk
npm install
npx cdk bootstrap aws://537090272317/us-east-1   # one-time
npx cdk deploy --require-approval never           # build + deploy everything
```

---

## 6. Cluster access

The AWS **account root user can't be mapped to EKS RBAC** (can't assume roles / not a
valid access-entry principal). So:
- cluster switched to `API_AND_CONFIG_MAP` auth mode,
- an IAM user **`concordia-kubectl`** (AdministratorAccess) was created and granted
  `AmazonEKSClusterAdminPolicy` via an access entry.

```bash
AWS_PROFILE=concordia-kubectl kubectl get pods -n concordia
```

Use this profile (not root) for `kubectl`/console. Its access key is in `~/.aws/credentials`.

---

## 7. Key decisions & fixes (the non-obvious stuff)

1. **Secrets Manager dynamic refs don't resolve inside EKS manifests.**
   `{{resolve:secretsmanager:…}}` reached the pod verbatim → auth failed DB login →
   CrashLoopBackOff → 502. Fix: literal secrets from `.secrets.json` + `rds.fromPassword`.
2. **MSK doesn't auto-create topics.** Register hung ~60s then 502'd (row committed, then
   the `user-registered` produce blocked on missing-topic metadata). Fix: `kafka-topic-init` Job.
3. **EBS CSI driver needs IRSA, not the node role.** Controller pods can't reach IMDS;
   attaching the policy to the node role fails the addon. Fix: dedicated IAM role bound to
   `kube-system/ebs-csi-controller-sa` via the cluster OIDC provider.
4. **web-app must be a Next.js server, not a static export.** Static export only
   pre-renders `generateStaticParams()` (just the `default` id), so real channel URLs
   hard-reloaded to the root page. Fix: `next build` + `next start` (`NEXT_OUTPUT=server`).
5. **nginx absolute-redirect leaked the pod's internal `:3000`** (earlier static-serve
   iteration) → fixed, then superseded by the server build.
6. **MinIO / attachments skipped** (app has no attachment flow yet; chat's S3 client is
   lazy so it runs without it). **`tips` service skipped** (not needed).
7. **Self-signed TLS** at the proxy (browser warning); no ACM/custom domain.

---

## 8. Cost & teardown

≈ **$270–290/mo if left running** (EKS control plane ~$72, 3 nodes ~$75, MSK ~$80–100,
RDS ~$15, ElastiCache ~$12, NLB + NAT ~$35).

```bash
cd infra/cdk && npx cdk destroy   # tears everything down (all data deleted)
```

> Keep `infra/cdk/.secrets.json` — deleting it regenerates secrets and rotates the RDS
> password on the next deploy.

---

## 9. Known follow-ups (not done, by choice)

- ~~`user-registered` event schema mismatch~~ **FIXED**: auth's `UserRegisteredEvent` was
  missing `@JsonProperty` snake_case annotations, so `servers`/`chat` couldn't read
  `user_id` and never populated their username caches. (Users registered before the fix
  aren't back-filled.)
- Hardening: ACM/custom domain, RDS backups + Multi-AZ, observability (Container
  Insights), autoscaling (HPA/cluster-autoscaler), Secrets Store CSI, CI/CD.
- Durability: Cassandra is single-node RF=1 on one EBS volume; nothing is HA.

---

## 10. Horizontal scaling & config knobs

### How "load balancing" works (vs the local Nginx LB)
There is **no Nginx `auth-lb`** in the cluster. Each service is a **Deployment** (N pods)
fronted by a **Kubernetes `Service`** (a stable ClusterIP/DNS, e.g. `auth:8081`).
The Service **is** the load balancer — `kube-proxy` spreads requests across the Deployment's
pods. So "more instances" = more replicas; "the LB" = the Service.

```bash
# Quick / temporary (reverts on next cdk deploy):
AWS_PROFILE=concordia-kubectl kubectl scale deploy/auth -n concordia --replicas=3
# Permanent: a CDK knob (below).
```
Stateless services (`auth`, `servers`, `chat`, `voice`, `presence`) scale freely. The
`gateway` is special — see the backplane below.

### CDK configuration knobs (passed per `cdk deploy`, NOT persisted)
The `deployment()` helper takes an optional `replicas`; a few `-c` context flags tune the stack:

| Flag | Default | Purpose |
|---|---|---|
| `-c gatewayReplicas=N` | `2` | gateway pod count; **>1 auto-enables the WS backplane** |
| `-c authReplicas=N` | `3` | auth pod count (stateless; balanced by the `auth` Service) |
| `-c apiRateLimit=N` | `100` | reverse-proxy `/api` rate limit (req/s); raise for load tests |
| `-c apiRateBurst=N` | `20` | reverse-proxy `/api` burst |
| `-c arch=amd64\|arm64` | `arm64` | image arch + node type (Graviton default) |
| `-c appOrigin=https://…` | — | strict CORS origin for the gateway |

> ⚠️ Context isn't remembered between deploys — **re-pass every non-default flag each time**
> (e.g. `cdk deploy -c gatewayReplicas=2 -c apiRateLimit=100000`), or the omitted ones snap
> back to their defaults.

### The gateway WebSocket backplane (how it's done)
**Problem:** a WS connection lives in **one** gateway pod's in-memory table, and chat
delivers real-time events by POSTing `/internal/push` with the `session_ids` (resolved from
Presence's `channel → connection_ids` index). With >1 gateway pod, that POST hits a *random*
pod (Service round-robin) which usually doesn't hold the socket → message lost. Also the old
`connID` was a per-pod counter (`conn-1`), so IDs collided across pods.

**Fix (Redis pub/sub backplane — the "backplane"/pub-sub adapter pattern):**
1. **Globally-unique `connID`** = `<pod-hostname>-<seq>` (`services/gateway/ws/handler.go`),
   so an id maps to exactly one pod. Flows to Presence via `registerSession`, so chat's
   resolved `session_ids` stay correct.
2. When `GATEWAY_WS_BACKPLANE=true`, `POST /internal/push` **publishes** the `{session_ids,
   event}` to the Redis channel `gateway:push` (reusing the gateway's existing ElastiCache
   client) instead of delivering locally.
3. **Every** gateway pod runs a subscriber goroutine (`runBackplane`) and calls `deliverLocal`
   — each writes to whatever `session_ids` it holds; others no-op. Publish-only avoids double
   delivery (the publisher is also a subscriber).

```
chat ─POST /internal/push─► any gateway pod ─PUBLISH gateway:push─► Redis
Redis ─fan-out─► every gateway pod's subscriber → deliverLocal() → writes to its local sockets
```

**Chat / presence / voice are unchanged; no new infra** (the gateway already had `REDIS_ADDR`).
The flag is **off by default** (single-replica keeps the simple direct-delivery path) and the
CDK sets it to `true` automatically whenever `gatewayReplicas > 1`. Sticky `/ws` routing is
**not** needed — a WebSocket is inherently pinned to its pod for the connection's lifetime.

**Scale the gateway:**
```bash
npx cdk deploy -c gatewayReplicas=3 -c apiRateLimit=100000   # backplane turns on automatically
```
Verify cross-pod delivery: two browser sessions in the same channel (they land on different
gateway pods) — one sends, the other receives live. Negative control:
`kubectl set env deploy/gateway -n concordia GATEWAY_WS_BACKPLANE=false` with >1 replica →
cross-pod messages stop arriving, confirming the backplane is what fixes it.

**Files:** `services/gateway/ws/handler.go` (backplane + unique connID),
`services/gateway/server.go` (`GATEWAY_WS_BACKPLANE` config), `infra/cdk/lib/cluster-construct.ts`
(`gatewayReplicas`, env), `infra/cdk/bin/concordia.ts` + `lib/concordia-stack.ts` (the knob).
