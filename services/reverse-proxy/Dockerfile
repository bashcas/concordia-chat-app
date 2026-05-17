# Concordia — Reverse Proxy (Pattern 1)
# Nginx as the single public-facing component. TLS certificates are NOT baked
# into the image — they are mounted read-only at runtime (../infra/certs).
FROM nginx:alpine

# Replace the default server block with the Concordia routing config.
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80 443
