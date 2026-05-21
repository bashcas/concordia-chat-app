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

exec nginx -g 'daemon off;'
