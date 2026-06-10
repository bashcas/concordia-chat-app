#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INFRA_DIR="$REPO_ROOT/infra"
ENV_FILE="$INFRA_DIR/.env"
K6_SCRIPT="$SCRIPT_DIR/login_test.js"

VU_LEVELS=(${VU_LEVELS:-1 50 100 200 500 1000 2000})
DURATION="${DURATION:-30s}"
BASE_URL="${BASE_URL:-http://localhost:8080}"

# Disable BuildKit's default provenance/SBOM attestations. On Docker Desktop the
# "resolving provenance for metadata file" export step can hang indefinitely
# after the image layers are built, stalling `compose up --build` before any
# container is created. We don't need attestations for a local perf run.
export BUILDX_NO_DEFAULT_ATTESTATIONS="${BUILDX_NO_DEFAULT_ATTESTATIONS:-1}"

# ── Load-balancing toggles (infra/.env) ───────────────────────────────────────
# Two independent flags select the topology under test (2x2 matrix):
#
#   SCALING_GATEWAY_LB  false → single gateway instance (no gateway LB)
#                       true  → 3 gateway replicas behind gateway-lb (least_conn)
#   SCALING_AUTH_LB     false → single auth instance, gateway → auth_1 directly
#                       true  → 3 auth replicas behind auth-lb (least_conn)
#
# The client always hits localhost:8080 (the single gateway or gateway-lb
# publishes it), so BASE_URL never changes. Flip a flag and re-run to compare
# "with vs without" that load balancer.
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi
SCALING_GATEWAY_LB="${SCALING_GATEWAY_LB:-false}"
SCALING_AUTH_LB="${SCALING_AUTH_LB:-false}"

is_true() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    true | 1 | yes | on) return 0 ;;
    *) return 1 ;;
  esac
}

command -v k6 >/dev/null || { echo "k6 not found. Install with: brew install k6"; exit 1; }
command -v docker >/dev/null || { echo "docker not found."; exit 1; }

COMMON_SERVICES=(zookeeper kafka kafka-init postgres)

# ── Auth topology ─────────────────────────────────────────────────────────────
# GATEWAY_AUTH_URL is read by the gateway container(s) (parameterized in the
# compose files) to point either at the single auth_1 or at the auth-lb pool.
if is_true "$SCALING_AUTH_LB"; then
  AUTH_MODE="AUTH LB ON  — auth x3 behind auth-lb (least_conn)"
  AUTH_SERVICES=(auth_1 auth_2 auth_3 auth-lb)
  export GATEWAY_AUTH_URL="http://auth-lb:8081"
else
  AUTH_MODE="AUTH LB OFF — single auth instance (gateway → auth_1)"
  AUTH_SERVICES=(auth_1)
  export GATEWAY_AUTH_URL="http://auth_1:8081"
fi

# ── Gateway topology ──────────────────────────────────────────────────────────
if is_true "$SCALING_GATEWAY_LB"; then
  GW_MODE="GATEWAY LB ON  — gateway x3 behind gateway-lb (least_conn)"
  COMPOSE_FILES=(-f "$INFRA_DIR/docker-compose.yml" -f "$INFRA_DIR/docker-compose.gateway-scale.yml")
  GATEWAY_SERVICES=(gateway gateway_2 gateway_3 gateway-lb)
else
  GW_MODE="GATEWAY LB OFF — single gateway instance (baseline)"
  COMPOSE_FILES=(-f "$INFRA_DIR/docker-compose.yml" -f "$INFRA_DIR/docker-compose.gateway-direct.yml")
  GATEWAY_SERVICES=(gateway)
fi

SERVICES=("${COMMON_SERVICES[@]}" "${AUTH_SERVICES[@]}" "${GATEWAY_SERVICES[@]}" web-app)

compose() {
  docker compose "${COMPOSE_FILES[@]}" "$@"
}

echo "============================================================"
echo "==> $GW_MODE"
echo "==> $AUTH_MODE"
echo "==>   SCALING_GATEWAY_LB=$SCALING_GATEWAY_LB  SCALING_AUTH_LB=$SCALING_AUTH_LB  (set in $ENV_FILE)"
echo "==>   gateway AUTH_URL=$GATEWAY_AUTH_URL"
echo "============================================================"
echo "==> Bringing up: ${SERVICES[*]}"
# Segmentation off so the published host port (8080) is reachable from the host.
# --remove-orphans clears containers from a previous topology (e.g. the legacy
# `auth` service, or the other LB mode) that would otherwise pin a stale network
# and break networking setup when the overlay set changes between runs.
SECURITY_NETWORK_SEGMENTATION=false compose up -d --build --remove-orphans "${SERVICES[@]}"

printf "==> Waiting for %s/health" "$BASE_URL"
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

# Show which gateway replica(s) answer, so the run log records the topology.
echo "==> Gateway instance(s) handling traffic (X-Gateway-Instance-Id):"
for _ in $(seq 1 6); do
  curl -s -o /dev/null -D - "$BASE_URL/health" 2>/dev/null | grep -i "X-Gateway-Instance-Id" || true
done | sort | uniq -c

# Show which auth replica(s) answer. /auth/login returns 4xx for the dummy body
# but still carries X-Instance-Id from the auth replica that handled it.
echo "==> Auth instance(s) handling traffic (X-Instance-Id):"
for _ in $(seq 1 6); do
  curl -s -o /dev/null -D - -X POST "$BASE_URL/auth/login" \
    -H 'Content-Type: application/json' -d '{}' 2>/dev/null \
    | grep -i "X-Instance-Id" || true
done | sort | uniq -c

for vus in "${VU_LEVELS[@]}"; do
  echo
  echo "============================================================"
  echo "==> k6 run @ VUs=$vus  DURATION=$DURATION"
  echo "==>   [$GW_MODE]"
  echo "==>   [$AUTH_MODE]"
  echo "============================================================"
  VUS="$vus" DURATION="$DURATION" BASE_URL="$BASE_URL" k6 run "$K6_SCRIPT"
done

echo
echo "==> Sweep complete. Stack is still up."
echo "    Tear down with:"
echo "      cd $INFRA_DIR && docker compose ${COMPOSE_FILES[*]} down"
echo
echo "    Flip SCALING_GATEWAY_LB / SCALING_AUTH_LB in $ENV_FILE, tear down, and"
echo "    re-run to sweep the other corners of the 2x2 matrix. Current run was:"
echo "      SCALING_GATEWAY_LB=$SCALING_GATEWAY_LB  SCALING_AUTH_LB=$SCALING_AUTH_LB"
