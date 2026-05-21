#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INFRA_DIR="$REPO_ROOT/infra"
K6_SCRIPT="$SCRIPT_DIR/login_test.js"

VU_LEVELS=(${VU_LEVELS:-1 50 100 200 500 1000 2000})
DURATION="${DURATION:-30s}"
BASE_URL="${BASE_URL:-http://localhost:8080}"

command -v k6 >/dev/null || { echo "k6 not found. Install with: brew install k6"; exit 1; }
command -v docker >/dev/null || { echo "docker not found."; exit 1; }

compose() {
  docker compose \
    -f "$INFRA_DIR/docker-compose.yml" \
    -f "$INFRA_DIR/docker-compose.gateway-direct.yml" \
    "$@"
}

echo "==> Bringing up minimal stack (zookeeper, kafka, kafka-init, postgres, auth, gateway, web-app)"
SECURITY_NETWORK_SEGMENTATION=false compose up -d \
  zookeeper kafka kafka-init postgres auth gateway web-app

printf "==> Waiting for gateway %s/health" "$BASE_URL"
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  printf '.'
  sleep 2
done
printf " ok\n"

printf "==> Waiting for auth via gateway"
for _ in {1..90}; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/auth/login" \
    -H 'Content-Type: application/json' -d '{}' || echo "000")
  if [[ "$code" =~ ^4 ]]; then
    printf " ok (got %s)\n" "$code"
    break
  fi
  printf '.'
  sleep 2
done

for vus in "${VU_LEVELS[@]}"; do
  echo
  echo "============================================================"
  echo "==> k6 run @ VUs=$vus  DURATION=$DURATION"
  echo "============================================================"
  VUS="$vus" DURATION="$DURATION" BASE_URL="$BASE_URL" k6 run "$K6_SCRIPT"
done

echo
echo "==> Sweep complete. Stack is still up."
echo "    Tear down with:"
echo "      cd $INFRA_DIR && docker compose -f docker-compose.yml -f docker-compose.gateway-direct.yml down"
