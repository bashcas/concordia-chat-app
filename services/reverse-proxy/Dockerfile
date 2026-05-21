# Concordia — Reverse Proxy (Pattern 1)
# Nginx as the single public-facing component. TLS certificates are NOT baked
# into the image — they are mounted read-only at runtime (../infra/certs).
FROM nginx:alpine

RUN rm -f /etc/nginx/conf.d/default.conf

COPY nginx-tls.conf nginx-plain.conf /etc/nginx/templates/
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENTRYPOINT ["/docker-entrypoint.sh"]

EXPOSE 80 443 8088
