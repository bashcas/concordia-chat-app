# Gateway Horizontal Scaling & Load Balancing (Lab 7)

Extends the auth-service scaling work (`docs/lab7.md`, `docs/lab7-commands.md`) to
the **Gateway**. The auth service is already load-balanced (`auth-lb → auth_1/2/3`);
this adds the same tactic one layer up so the Gateway is no longer a single point
of contention.

```
client → gateway-lb (Nginx, least_conn) → [gateway, gateway_2, gateway_3] → auth-lb → [auth_1, auth_2, auth_3]
```

## Scenario (ASR)

When concurrent users exceed a single Gateway/Auth instance's capacity, the system
distributes incoming requests across multiple replicas via a load balancer so no
single instance becomes the bottleneck and throughput scales horizontally.

- **Stimulus:** auth/login load crosses ~100 concurrent VUs (the single-instance
  breakpoint from the prior prototype), pushing response times > 2 s and rising
  error rates on one Gateway + Auth instance.
- **Response:** 3 Gateway replicas + 2–3 Auth replicas. Nginx balances with
  `least_conn` and drops unhealthy instances from the pool via health checks.
  Every instance is stateless (session state in shared Redis; auth via stateless JWT).
- **Measure (target):** ~300 VUs with 0 % errors, avg < 800 ms, p95 < 1500 ms;
  throughput scales from ~30 req/s (1 instance) to ~85 req/s (3 instances).

## What was added

| Piece | Path |
|---|---|
| Gateway replicas + LB overlay | `infra/docker-compose.gateway-scale.yml` |
| Nginx LB configs (3 algorithms) | `services/gateway-lb/nginx.{least-conn,round-robin,ip-hash}.conf` |
| Per-replica identity header | `services/gateway/middleware/instanceid.go` → `X-Gateway-Instance-Id` |
| Toggle flags | `SCALING_GATEWAY_LB`, `SCALING_AUTH_LB` in `infra/.env` |
| Parameterized gateway upstream | `GATEWAY_AUTH_URL` (compose) → `auth_1` or `auth-lb` |
| Perf harness (flag-aware) | `tests/perf/run_login_test.sh` |

`least_conn` is the default mounted config — it suits the Gateway because each
login fans out to bcrypt-bound auth replicas, so per-request cost is variable
and bursty. Round-robin and ip-hash are provided for an algorithm comparison.

## Statelessness — why this is safe (and where it isn't)

The Gateway is stateless for REST/login: it validates the JWT and proxies
upstream, holding no per-client state. Any replica can serve any login request,
which is what makes round-robin / least_conn correct here.

**Exception — WebSockets.** `GET /ws` connections are held *in-memory* by one
Gateway replica (`services/gateway/ws/handler.go`), and Chat's
`POST /internal/push` must reach *that same* replica to deliver an event. Spreading
`/ws` + `/internal/push` across replicas would break real-time delivery (a push
would land on a replica that doesn't hold the target socket). So:

- The gateway-scale overlay is for the **stateless login/throughput experiment**.
- The default app stack (`./infra/up.sh`) keeps a **single Gateway**, so WebSockets
  keep working. `SCALING_GATEWAY_LB` does **not** affect `up.sh`.
- Productionising multi-replica WebSockets would need sticky `/ws` routing plus a
  shared pub/sub (e.g. Redis) for `/internal/push` fan-out — out of scope for the lab.

## Running the perf comparison

Two **independent** toggles live in `infra/.env`, giving a 2×2 matrix:

```bash
# infra/.env
SCALING_GATEWAY_LB=false|true   # single gateway          | gateway x3 behind gateway-lb
SCALING_AUTH_LB=false|true      # single auth (→ auth_1)   | auth x3 behind auth-lb
```

The client always hits `http://localhost:8080` (the single gateway or the
gateway-lb publishes it), so `BASE_URL` never changes. The auth side switches by
repointing the gateway's upstream (`GATEWAY_AUTH_URL` → `auth_1:8081` or
`auth-lb:8081`) — the harness sets this automatically from the flag.

| `SCALING_GATEWAY_LB` | `SCALING_AUTH_LB` | Topology |
|---|---|---|
| false | false | single gateway → single auth (full baseline) |
| false | true  | single gateway → auth x3 |
| true  | false | gateway x3 → single auth |
| true  | true  | gateway x3 → auth x3 (full scale-out) |

```bash
# Example: full baseline vs full scale-out
# (set both flags = false)
VU_LEVELS="1 50 100 200 300" DURATION=30s \
  ./tests/perf/run_login_test.sh | tee results_baseline.txt
cd infra && docker compose -f docker-compose.yml -f docker-compose.gateway-direct.yml down && cd ..

# (set both flags = true)
VU_LEVELS="1 50 100 200 300" DURATION=30s \
  ./tests/perf/run_login_test.sh | tee results_scaled.txt
cd infra && docker compose -f docker-compose.yml -f docker-compose.gateway-scale.yml down && cd ..
```

The script prints the active mode for both layers, waits for `:8080/health`, then
prints which `X-Gateway-Instance-Id` and `X-Instance-Id` (auth) replicas answer —
one value each in baseline; the pool cycling when its LB is on — before the k6 sweep.

> Sweep one flag at a time to attribute the delta to a single layer; sweep both
> for the headline "single instance vs full horizontal scale-out" number.

### Metrics to record (per VU level)

`http_req_duration` avg & **p95**, `http_reqs` rate (req/s), and
`http_req_failed` (error rate). Tabulate baseline vs LB side by side and note the
VU level where the single instance degrades (> 2 s / rising errors) versus where
the 3-replica pool still holds (target: 300 VUs, 0 % errors, p95 < 1500 ms).

## Switching the balancing algorithm

Edit the mounted file in `infra/docker-compose.gateway-scale.yml` (`gateway-lb`
service `volumes:`), then recreate only the LB:

```yaml
- ../services/gateway-lb/nginx.least-conn.conf:/etc/nginx/nginx.conf:ro   # default
# - ../services/gateway-lb/nginx.round-robin.conf:/etc/nginx/nginx.conf:ro
# - ../services/gateway-lb/nginx.ip-hash.conf:/etc/nginx/nginx.conf:ro
```

```bash
cd infra
docker compose -f docker-compose.yml -f docker-compose.gateway-scale.yml \
  up -d --no-deps gateway-lb
docker logs gateway-lb --tail 20    # confirm clean reload
```

Re-run the sweep after each switch. Note that **ip_hash pins all traffic to one
replica** when the client is k6 from a single host IP — the same limitation
documented for `auth-lb` in `docs/lab7-commands.md` §5.

## Observing distribution / failure resilience

```bash
# Distribution across replicas (LB on):
for i in $(seq 1 9); do
  curl -s -D - -o /dev/null http://localhost:8080/health | grep -i X-Gateway-Instance-Id
done

# Failure resilience: kill a replica mid-traffic — the LB drops it, 0 errors.
docker compose -f infra/docker-compose.yml -f infra/docker-compose.gateway-scale.yml stop gateway_2
# ...re-run the loop: only gateway / gateway_3 answer...
docker compose -f infra/docker-compose.yml -f infra/docker-compose.gateway-scale.yml start gateway_2
```
