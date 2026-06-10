#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K6_SCRIPT="$SCRIPT_DIR/messages_cache_test.js"

if [[ -z "${BASE_URL:-}" ]]; then
  cat <<'USAGE'
Usage: BASE_URL=https://<nlb>.elb.us-east-1.amazonaws.com/api ./run_messages_cache_test.sh

Mide GET /channels/{id}/messages (patrón Cache-Aside en el Chat service). Corre una vez con
el cache deshabilitado y otra habilitado, y compara http_reqs (req/s), http_req_duration p95
y cache_hit_rate:

  K="AWS_PROFILE=concordia-kubectl kubectl -n concordia"
  # Desactiva el rate-limit del gateway solo para medir (la carga debe llegar al cache/BD):
  eval $K set env deploy/gateway RATE_LIMIT_ENABLED=false
  # (A) sin cache:
  eval $K set env deploy/chat CHAT_CACHE_ENABLED=false; eval $K rollout status deploy/chat
  BASE_URL=... ./run_messages_cache_test.sh | tee results_nocache.txt
  # (B) con cache:
  eval $K set env deploy/chat CHAT_CACHE_ENABLED=true;  eval $K rollout status deploy/chat
  BASE_URL=... ./run_messages_cache_test.sh | tee results_cache.txt
  # Restaurar seguridad:
  eval $K set env deploy/gateway RATE_LIMIT_ENABLED=true

Overrides opcionales: VU_LEVELS="1 50 100 200 300"  DURATION="30s"
USAGE
  exit 1
fi

VU_LEVELS=(${VU_LEVELS:-1 50 100 200 300})
DURATION="${DURATION:-30s}"

# Skip TLS verification by default (the NLB cert is self-signed).
export K6_INSECURE_SKIP_TLS_VERIFY="${K6_INSECURE_SKIP_TLS_VERIFY:-true}"

command -v k6 >/dev/null || { echo "k6 not found. Install with: brew install k6"; exit 1; }

printf "==> Smoke test: GET %s/health " "$BASE_URL"
if ! curl -fsS -k --max-time 5 "$BASE_URL/health" >/dev/null; then
  printf "FAIL\n    No se pudo alcanzar %s/health.\n" "$BASE_URL"
  exit 1
fi
printf "ok\n"

for vus in "${VU_LEVELS[@]}"; do
  echo
  echo "============================================================"
  echo "==> k6 GET messages @ VUs=$vus  DURATION=$DURATION  BASE_URL=$BASE_URL"
  echo "============================================================"
  VUS="$vus" DURATION="$DURATION" BASE_URL="$BASE_URL" k6 run "$K6_SCRIPT"
done
