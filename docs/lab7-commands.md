# Lab 7 — Test Commands

Concrete commands to demonstrate horizontal scaling of the auth service.
Architecture: `reverse-proxy → gateway → auth-lb → [auth_1, auth_2, auth_3]`.

All commands assume CWD `infra/` for docker compose, and the stack already running (`bash up.sh --build -d`).

---

## 0. Start / status

```bash
bash infra/up.sh --build -d
docker compose ps | grep -E "auth_|auth-lb|reverse-proxy|gateway"
```

Expect: `auth_1`, `auth_2`, `auth_3`, `auth-lb`, `gateway`, `reverse-proxy` all healthy.

---

## 1. Basic round-trip (single request)

Hits the full public path. `POST /api/auth/login` is public; invalid creds return `403`, but the response still carries `X-Instance-Id` from the replica that handled it.

```bash
curl -s -i -X POST https://localhost/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"x","password":"x"}' \
  | grep -iE "HTTP|X-Instance-Id"
```

Expect:

```
HTTP/1.1 403 Forbidden
X-Instance-Id: auth_2     # one of auth_1 / auth_2 / auth_3
```

---

## 2. Round-Robin distribution (9 requests)

With `nginx.round-robin.conf` mounted (the default), each replica should appear ~3 times.

```bash
for i in $(seq 1 9); do
  curl -s -i -X POST https://localhost/api/auth/login \
    -H "Content-Type: application/json" \
    -d '{"username":"x","password":"x"}' \
    | grep -i "X-Instance-Id"
done
```

Expect: `auth_1 → auth_2 → auth_3` cycling cleanly.

---

## 3. Failure resilience (stop & restore a replica)

```bash
# Stop one replica
docker compose stop auth_2

# Repeat the 9-request loop — only auth_1 and auth_3 should appear, zero errors
for i in $(seq 1 6); do
  curl -s -i -X POST https://localhost/api/auth/login \
    -H "Content-Type: application/json" \
    -d '{"username":"x","password":"x"}' \
    | grep -i "X-Instance-Id"
done

# Restore it
docker compose start auth_2

# Confirm it re-enters rotation
for i in $(seq 1 9); do
  curl -s -i -X POST https://localhost/api/auth/login \
    -H "Content-Type: application/json" \
    -d '{"username":"x","password":"x"}' \
    | grep -i "X-Instance-Id"
done
```

---

## 4. Switching the balancing algorithm

Edit `infra/docker-compose.yml`, find the `auth-lb` service's `volumes:` block, change the mounted file:

```yaml
# Round Robin (default)
- ../services/auth-lb/nginx.round-robin.conf:/etc/nginx/nginx.conf:ro

# Least Connections
- ../services/auth-lb/nginx.least-conn.conf:/etc/nginx/nginx.conf:ro

# IP Hash
- ../services/auth-lb/nginx.ip-hash.conf:/etc/nginx/nginx.conf:ro
```

Recreate **only** the load balancer (backends keep running):

```bash
docker compose up -d --no-deps auth-lb
docker logs auth-lb --tail 20    # confirm clean reload, no syntax errors
```

Then re-run the 9-request loop from §2 and observe how distribution changes.

---

## 5. IP Hash limitation (expected finding)

Mount `nginx.ip-hash.conf` (§4), then re-run the loop:

```bash
for i in $(seq 1 9); do
  curl -s -i -X POST http://localhost:8088/api/auth/login \
    -H "Content-Type: application/json" \
    -d '{"username":"x","password":"x"}' \
    | grep -i "X-Instance-Id"
done
```

Expect: **all 9 responses pin to the same replica**.

Reason: every request reaches `auth-lb` from a single source IP — the gateway container — so `ip_hash` always selects the same upstream. This is a real demonstration of why `ip_hash` is unsuitable when the immediate client is itself a proxy. Document this in the writeup.

---

## 6. Backend isolation (replicas & LB are private)

None of the auth replicas or the LB should be reachable from the host — only the reverse proxy is public.

```bash
# auth-lb on :8081 (private-net only, no port mapping)
curl -s -o /dev/null -w "auth-lb host:8081 -> %{http_code}\n" --max-time 3 http://localhost:8081/health

# Inspect: no published ports
docker inspect auth-lb --format '{{json .NetworkSettings.Ports}}'
docker inspect auth_1  --format '{{json .NetworkSettings.Ports}}'
```

Expect: `000` (connection refused) and `{}` for `Ports`.

---

## 7. Inspect the upstream pool at runtime

```bash
# Show the active Nginx config inside the LB — confirms which algorithm is mounted
docker exec auth-lb nginx -T 2>/dev/null | grep -E "upstream|server auth_|least_conn|ip_hash"

# Tail the LB access log to watch distribution in real time
docker logs -f auth-lb
```

---

## 8. Direct verification from inside the Docker network

Bypasses the gateway/reverse-proxy entirely — useful for isolating LB behavior from other layers.

```bash
for i in $(seq 1 9); do
  docker exec gateway wget -qSO /dev/null http://auth-lb:8081/health 2>&1 \
    | grep -i "X-Instance-Id"
done
```

---

## 9. Performance comparison (k6, vs Lab 6 baseline)

The gateway's `AUTH_URL` is already pointed at `auth-lb`, so the existing Lab 6 perf script automatically exercises the load-balanced pool — no test changes needed. Compare results against `results.txt` / `results_remote.txt`.

```bash
# Run from repo root
k6 run tests/perf/login_test.js
```

Repeat the run after each algorithm switch (§4) for an algorithm-vs-algorithm comparison. Key metrics to log: `http_req_duration` (p95), `http_reqs/s`, and error rate.

For a quick scale-down comparison, stop one replica and re-run:

```bash
docker compose stop auth_3
k6 run tests/perf/login_test.js     # 2 replicas
docker compose start auth_3
```

---

## 10. Gateway horizontal scaling (extends this lab to the Gateway)

The same tactic is applied one layer up — the Gateway now scales to 3 replicas
behind `gateway-lb` (Nginx `least_conn`). Two independent `.env` flags let the
perf harness measure **with vs without** each load balancer (a 2×2 matrix):

```bash
# infra/.env
SCALING_GATEWAY_LB=false|true   # single gateway        | gateway x3 behind gateway-lb
SCALING_AUTH_LB=false|true      # single auth (→ auth_1) | auth x3 behind auth-lb
```

```bash
# Flip the flag, then run the (now flag-aware) perf harness — BASE_URL is :8080
# in both modes (single gateway vs gateway-lb publish it):
VU_LEVELS="1 50 100 200 300" DURATION=30s ./tests/perf/run_login_test.sh
```

Each Gateway replica stamps responses with `X-Gateway-Instance-Id` (distinct from
auth's `X-Instance-Id`, since a login crosses both load balancers):

```bash
for i in $(seq 1 9); do
  curl -s -D - -o /dev/null http://localhost:8080/health | grep -i X-Gateway-Instance-Id
done
```

> Scope: stateless REST/login only. WebSockets stay on a single Gateway in the
> default `./infra/up.sh` stack. Full methodology, algorithm switching, and the
> results template: **`docs/gateway-load-balancing.md`**.
