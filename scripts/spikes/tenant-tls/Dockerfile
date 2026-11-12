# Caddy with a chosen set of DNS provider modules.
#   docker build --build-arg CADDY_PLUGINS="github.com/caddy-dns/route53" ...
FROM caddy:2-builder AS builder
ARG CADDY_PLUGINS="github.com/caddy-dns/cloudflare"
RUN set -eu; args=""; for p in $CADDY_PLUGINS; do args="$args --with $p"; done; \
    xcaddy build $args

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
