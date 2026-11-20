#!/bin/sh
# Copy the wildcard certificate of BASE_DOMAIN from Caddy's storage to the
# volume that the gateway reads (ADR-0030). Caddy's files are readable by
# root only; the copies belong to the coordinator's user.
#
# Runs for ever: it looks every 30 s until the first copy (Caddy issues the
# certificate only after it starts, which is after this service), then once
# an hour, and copies only when the certificate changed. A new file is written next to the old one and then moved over
# it, so the gateway never reads a half-written file.

set -u

CADDY_DIR="${CADDY_DIR:-/caddy/caddy/certificates}"
OUT_DIR="${OUT_DIR:-/certs}"
NAME="wildcard_.${BASE_DOMAIN:?BASE_DOMAIN must be set}"

copy_once() {
  for dir in "$CADDY_DIR"/*/"$NAME"; do
    crt="$dir/$NAME.crt"
    key="$dir/$NAME.key"
    [ -f "$crt" ] && [ -f "$key" ] || continue
    cmp -s "$crt" "$OUT_DIR/tls.crt" && continue
    cp "$key" "$OUT_DIR/tls.key.new" || continue
    cp "$crt" "$OUT_DIR/tls.crt.new" || continue
    chown coord:coord "$OUT_DIR/tls.key.new" "$OUT_DIR/tls.crt.new"
    chmod 0400 "$OUT_DIR/tls.key.new"
    chmod 0444 "$OUT_DIR/tls.crt.new"
    mv "$OUT_DIR/tls.key.new" "$OUT_DIR/tls.key"
    mv "$OUT_DIR/tls.crt.new" "$OUT_DIR/tls.crt"
    echo "gateway certificate updated from $dir"
  done
}

while true; do
  copy_once
  if [ -f "$OUT_DIR/tls.crt" ]; then sleep 3600; else sleep 30; fi
done
