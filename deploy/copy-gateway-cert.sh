#!/bin/sh
# Copy the wildcard certificate of SERVICE_DOMAIN (only that one, ADR-0038)
# from Caddy's storage to the volume that the gateway reads.
# Checks every 30 s until the first copy, then every hour.
#
# Security: the key file is 0600 and belongs to the gateway's user. Each file
# is written next to the old one and then renamed, so the gateway never reads
# a partial file. The key goes first: a reload that sees a new key with an old
# certificate fails and keeps the old pair.

set -u
umask 077

CADDY_DIR="${CADDY_DIR:-/caddy/caddy/certificates}"
OUT_DIR="${OUT_DIR:-/certs}"
OWNER="${CERT_OWNER:-coord:coord}"
NAME="wildcard_.${SERVICE_DOMAIN:?SERVICE_DOMAIN must be set}"

# install(1) creates the temporary file with its final owner and mode.
put() {
  install -o "${OWNER%%:*}" -g "${OWNER##*:}" -m "$3" "$1" "$OUT_DIR/.$2.new" &&
    mv -f "$OUT_DIR/.$2.new" "$OUT_DIR/$2"
}

copy_once() {
  for dir in "$CADDY_DIR"/*/"$NAME"; do
    crt="$dir/$NAME.crt"
    key="$dir/$NAME.key"
    [ -f "$crt" ] && [ -f "$key" ] || continue
    cmp -s "$crt" "$OUT_DIR/tls.crt" && cmp -s "$key" "$OUT_DIR/tls.key" && continue
    put "$key" tls.key 0600 || continue
    put "$crt" tls.crt 0644 || continue
    echo "gateway certificate for *.$SERVICE_DOMAIN updated from $dir"
  done
}

# Copies of an earlier version covered all of BASE_DOMAIN. Remove them.
if [ -f "$OUT_DIR/tls.crt" ] && ! grep -qs . "$OUT_DIR/.scope-$SERVICE_DOMAIN"; then
  rm -f "$OUT_DIR/tls.crt" "$OUT_DIR/tls.key" "$OUT_DIR"/.scope-*
fi
echo "$SERVICE_DOMAIN" > "$OUT_DIR/.scope-$SERVICE_DOMAIN"

while true; do
  copy_once
  if [ -f "$OUT_DIR/tls.crt" ]; then sleep 3600; else sleep 30; fi
done
