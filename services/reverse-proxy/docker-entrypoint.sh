#!/bin/sh
set -e

# Only default.conf may live in conf.d — loading both templates caused duplicate
# limit_req_zone definitions and nginx exited on startup.
rm -f /etc/nginx/conf.d/*.conf

case "${SECURITY_SECURE_CHANNEL}" in
  false|FALSE|0|no|NO)
    cp /etc/nginx/templates/nginx-plain.conf /etc/nginx/conf.d/default.conf
    ;;
  *)
    cp /etc/nginx/templates/nginx-tls.conf /etc/nginx/conf.d/default.conf
    ;;
esac

# Substitute the configurable /api rate limit (req/s) and burst. Defaults preserve
# the original 100 r/s + burst 20; raise API_RATE_LIMIT for load testing.
API_RATE_LIMIT="${API_RATE_LIMIT:-100}"
API_RATE_BURST="${API_RATE_BURST:-20}"
sed -i \
  -e "s/__API_RATE_LIMIT__/${API_RATE_LIMIT}/g" \
  -e "s/__API_RATE_BURST__/${API_RATE_BURST}/g" \
  /etc/nginx/conf.d/default.conf

exec nginx -g 'daemon off;'
