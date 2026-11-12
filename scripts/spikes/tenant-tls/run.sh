#!/usr/bin/env bash
# Tenant TLS strategy spike (ADR-0022). Builds Caddy with several DNS provider
# modules, checks that each strategy in modes/ loads in a production-shaped
# Caddyfile, then runs the two local stand-ins (Caddy's internal CA instead of
# ACME) to compare wildcard and on-demand behaviour with the service's managed
# tenant route. No real certificate authority or DNS provider is contacted.
#
#   scripts/spikes/tenant-tls/run.sh        # leaves nothing running
set -u
cd "$(dirname "$0")"
REPO=$(cd ../../.. && pwd)
IMG=tlsspike-caddy
PLUGINS="github.com/caddy-dns/cloudflare github.com/caddy-dns/route53 github.com/caddy-dns/digitalocean github.com/caddy-dns/rfc2136 github.com/caddy-dns/acmedns"
HTTPS=8447 ADMIN=2022
pass=0 fail=0
ok()  { echo "PASS  $*"; pass=$((pass+1)); }
bad() { echo "FAIL  $*"; fail=$((fail+1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }
cleanup() { docker rm -f tlsspike >/dev/null 2>&1; rm -rf "$TMP"; }
TMP=$(mktemp -d); trap cleanup EXIT

echo "== build"
docker build -q --build-arg CADDY_PLUGINS="$PLUGINS" -t $IMG . >/dev/null || { echo "build failed"; exit 1; }
docker run --rm $IMG caddy list-modules 2>/dev/null | grep '^dns.providers' | tr '\n' ' '; echo

echo "== each strategy loads"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 \
  -subj "/CN=*.ts.example.test" -addext "subjectAltName=DNS:*.ts.example.test" \
  -keyout "$TMP/wildcard.key" -out "$TMP/wildcard.pem" 2>/dev/null
chmod 644 "$TMP/wildcard.key"
# Dummy values with the shape each module expects; nothing is contacted by `validate`.
ENVS="-e CF_API_TOKEN=0123456789abcdef0123456789abcdef01234567 -e AWS_REGION=us-east-1
  -e AWS_ACCESS_KEY_ID=AKIAEXAMPLE -e AWS_SECRET_ACCESS_KEY=example -e DO_AUTH_TOKEN=dop_v1_example
  -e RFC2136_KEY_NAME=acme -e RFC2136_KEY=cWnu6Ju9zOki4f7Q+da2KKGo0KOXbCf6Pej6hW3geC4= -e RFC2136_SERVER=192.0.2.1:53
  -e ACMEDNS_USERNAME=u -e ACMEDNS_PASSWORD=p -e ACMEDNS_SUBDOMAIN=s -e ACMEDNS_SERVER_URL=https://auth.example.net"
for mode in modes/*/; do
  m=$(basename "$mode")
  out=$(docker run --rm $ENVS -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$PWD/$mode:/etc/caddy/mode:ro" \
        -v "$TMP:/etc/caddy/certs:ro" $IMG caddy validate --config /etc/caddy/Caddyfile 2>&1 | tail -1)
  case "$out" in *"Valid configuration"*) ok "loads: $m";; *) bad "loads: $m — ${out:0:240}";; esac
done
out=$(docker run --rm $ENVS -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$PWD/modes/route53:/etc/caddy/mode:ro" \
      caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile 2>&1 | tail -1)
case "$out" in *"module not registered"*) ok "stock image refuses a DNS module it was not built with";; *) bad "stock image: ${out:0:200}";; esac

live() { # $1 = mode
  docker rm -f tlsspike >/dev/null 2>&1
  docker run -d --name tlsspike -p 127.0.0.1:$HTTPS:443 -p 127.0.0.1:$ADMIN:2019 \
    -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$PWD/modes/$1:/etc/caddy/mode:ro" $IMG >/dev/null
  for _ in $(seq 1 20); do curl -s -o /dev/null "http://localhost:$ADMIN/config/" && break; sleep 0.5; done
  (cd "$REPO" && CADDY_ADMIN_URL=http://localhost:$ADMIN BASE_DOMAIN=ts.example.test HEADSCALE_NETWORK= LOG_LEVEL=warn \
     npx tsx scripts/spikes/tenant-tls/apply-router.mts 2>&1 | tail -1)
  sleep 1
}
get()  { curl -sk --max-time 10 -o "$TMP/body" -w '%{http_code}' --resolve "$1:$HTTPS:127.0.0.1" "https://$1:$HTTPS/"; }
san()  { echo | openssl s_client -connect 127.0.0.1:$HTTPS -servername "$1" 2>/dev/null | openssl x509 -noout -ext subjectAltName 2>/dev/null | tail -1 | tr -d ' '; }

echo "== live: wildcard certificate (stand-in for every DNS-challenge strategy)"
check "managed route installed" "$(live local-wildcard)" "created"
check "tenant is proxied"                      "$(get acme.ts.example.test) $(cat $TMP/body)" "200 tenant upstream"
check "tenant is served the wildcard cert"     "$(san acme.ts.example.test)" "DNS:*.ts.example.test"
check "unknown name gets 404, same cert"       "$(get nosuch.ts.example.test) $(san nosuch.ts.example.test)" "404 DNS:*.ts.example.test"
check "main app unaffected"                    "$(get tailnets.example.test) $(cat $TMP/body)" "200 main app"

echo "== live: on-demand certificates (no DNS credentials)"
check "managed route installed" "$(live local-on-demand)" "created"
check "tenant is proxied"                      "$(get acme.ts.example.test) $(cat $TMP/body)" "200 tenant upstream"
check "tenant gets a certificate naming it"    "$(san acme.ts.example.test)" "DNS:acme.ts.example.test"
get nosuch.ts.example.test >/dev/null; rc=$?
check "unknown name: no certificate, handshake refused (curl exit)" "$rc" "35"
check "unknown name: nothing issued"           "$(san nosuch.ts.example.test)" ""
check "main app unaffected"                    "$(get tailnets.example.test) $(cat $TMP/body)" "200 main app"

echo; echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
