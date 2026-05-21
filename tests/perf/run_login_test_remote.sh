#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K6_SCRIPT="$SCRIPT_DIR/login_test.js"

if [[ -z "${BASE_URL:-}" ]]; then
  cat <<'USAGE'
Usage: BASE_URL=http://<host>:<port> ./run_login_test_remote.sh

Examples:
  # LAN (other Mac on the same WiFi as the server):
  BASE_URL=http://192.168.1.42:8080 ./run_login_test_remote.sh

  # Public tunnel (Cloudflare, ngrok, etc.):
  BASE_URL=https://your-tunnel.example.com ./run_login_test_remote.sh

Optional overrides:
  VU_LEVELS="1 50 100 200 500 1000 2000"   # space-separated list of VU counts
  DURATION="30s"                            # duration per level
USAGE
  exit 1
fi

VU_LEVELS=(${VU_LEVELS:-1 50 100 200 500 1000 2000})
DURATION="${DURATION:-30s}"

command -v k6 >/dev/null || { echo "k6 not found. Install with: brew install k6"; exit 1; }

printf "==> Smoke test: GET %s/health " "$BASE_URL"
if ! curl -fsS --max-time 5 "$BASE_URL/health" >/dev/null; then
  printf "FAIL\n"
  echo "    Cannot reach $BASE_URL/health. Check the URL, the server, and the network."
  exit 1
fi
printf "ok\n"

for vus in "${VU_LEVELS[@]}"; do
  echo
  echo "============================================================"
  echo "==> k6 run @ VUs=$vus  DURATION=$DURATION  BASE_URL=$BASE_URL"
  echo "============================================================"
  VUS="$vus" DURATION="$DURATION" BASE_URL="$BASE_URL" k6 run "$K6_SCRIPT"
done
