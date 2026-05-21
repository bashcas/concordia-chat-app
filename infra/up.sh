#!/usr/bin/env bash
# Start the Concordia stack with SECURITY_* pattern flags from infra/.env.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "ROOT: ${ROOT}"
ENV_FILE="${ROOT}/infra/.env"
COMPOSE_FILE="${ROOT}/infra/docker-compose.yml"
COMPOSE_DIRECT="${ROOT}/infra/docker-compose.gateway-direct.yml"

is_true() {
  local v
  v=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  case "${v}" in
    true | 1 | yes | on) return 0 ;;
    *) return 1 ;;
  esac
}

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

SECURITY_REVERSE_PROXY="${SECURITY_REVERSE_PROXY:-true}"
SECURITY_NETWORK_SEGMENTATION="${SECURITY_NETWORK_SEGMENTATION:-true}"
SECURITY_AUDIT_TRAIL="${SECURITY_AUDIT_TRAIL:-true}"
SECURITY_SECURE_CHANNEL="${SECURITY_SECURE_CHANNEL:-true}"

if ! is_true "${SECURITY_REVERSE_PROXY}" && is_true "${SECURITY_NETWORK_SEGMENTATION}"; then
  echo "error: SECURITY_REVERSE_PROXY=false requires SECURITY_NETWORK_SEGMENTATION=false" >&2
  echo "       (the gateway is not published on the host when the private network is internal)" >&2
  exit 1
fi

profiles=()
if is_true "${SECURITY_REVERSE_PROXY}"; then
  profiles+=("reverse-proxy")
fi
if is_true "${SECURITY_AUDIT_TRAIL}"; then
  profiles+=("audit-trail")
fi
export COMPOSE_PROFILES="$(
  IFS=,
  echo "${profiles[*]}"
)"

compose_args=(-f "${COMPOSE_FILE}")

if is_true "${SECURITY_REVERSE_PROXY}"; then
  export NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-/api}"
  export GATEWAY_TLS_ENABLED="false"
  export GATEWAY_ALLOWED_ORIGINS="${GATEWAY_ALLOWED_ORIGINS:-https://localhost,app://-}"
  if is_true "${SECURITY_SECURE_CHANNEL}"; then
    entry_url="https://localhost"
  else
    entry_url="http://localhost:8088"
  fi
else
  compose_args+=(-f "${COMPOSE_DIRECT}")
  # Browser loads the web app from :3000 but calls the gateway on :8080 — both origins
  # must be allowed or login/API fetches fail CORS (different host:port).
  if is_true "${SECURITY_SECURE_CHANNEL}"; then
    export NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-https://localhost:8080}"
    export GATEWAY_TLS_ENABLED="true"
    export GATEWAY_ALLOWED_ORIGINS="${GATEWAY_ALLOWED_ORIGINS:-https://localhost:8080,http://localhost:3000,app://-}"
    entry_url="https://localhost:8080"
  else
    export NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-http://localhost:8080}"
    export GATEWAY_TLS_ENABLED="false"
    export GATEWAY_ALLOWED_ORIGINS="${GATEWAY_ALLOWED_ORIGINS:-http://localhost:8080,http://localhost:3000,app://-}"
    entry_url="http://localhost:8080"
  fi
fi

export SECURITY_SECURE_CHANNEL
export SECURITY_NETWORK_SEGMENTATION

print_mode() {
  echo "Security pattern flags:"
  echo "  SECURITY_REVERSE_PROXY=${SECURITY_REVERSE_PROXY}"
  echo "  SECURITY_NETWORK_SEGMENTATION=${SECURITY_NETWORK_SEGMENTATION}"
  echo "  SECURITY_AUDIT_TRAIL=${SECURITY_AUDIT_TRAIL}"
  echo "  SECURITY_SECURE_CHANNEL=${SECURITY_SECURE_CHANNEL}"
  echo ""
  echo "Derived:"
  echo "  COMPOSE_PROFILES=${COMPOSE_PROFILES:-<none>}"
  echo "  GATEWAY_TLS_ENABLED=${GATEWAY_TLS_ENABLED}"
  echo "  GATEWAY_ALLOWED_ORIGINS=${GATEWAY_ALLOWED_ORIGINS}"
  echo "  NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}"
  echo ""
  echo "Active patterns:"
  is_true "${SECURITY_REVERSE_PROXY}" && echo "  [on]  Reverse Proxy" || echo "  [off] Reverse Proxy"
  is_true "${SECURITY_NETWORK_SEGMENTATION}" && echo "  [on]  Network Segmentation" || echo "  [off] Network Segmentation"
  is_true "${SECURITY_AUDIT_TRAIL}" && echo "  [on]  Audit Trail (consumer + DB)" || echo "  [off] Audit Trail (producers still emit to Kafka)"
  is_true "${SECURITY_SECURE_CHANNEL}" && echo "  [on]  Secure Channel (TLS)" || echo "  [off] Secure Channel (plain HTTP)"
  echo ""
  echo "Open: ${entry_url}"
  if ! is_true "${SECURITY_REVERSE_PROXY}"; then
    echo "Web app (direct): http://localhost:3000"
  fi
}

if [[ "${1:-}" == "--print" ]]; then
  print_mode
  exit 0
fi

compose_env=()
if [[ -f "${ENV_FILE}" ]]; then
  compose_env=(--env-file "${ENV_FILE}")
else
  echo "warning: ${ENV_FILE} not found — copy infra/.env.example to infra/.env" >&2
fi

print_mode
echo ""
echo "Starting stack..."
exec docker compose "${compose_env[@]}" "${compose_args[@]}" up "$@"
