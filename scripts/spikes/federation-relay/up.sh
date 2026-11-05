#!/usr/bin/env bash
# Federation relay feasibility spike: two Headscale 0.29.1 tenants (A, B) joined
# by a relay made of two tailscaled nodes acting as subnet routers for the
# *other* tenant's CIDR.
#
#   ./up.sh                 two relay containers joined by a private docker network (default)
#   MODE=single ./up.sh     one relay container running two tailscaled processes
#   DERP=dummy ./up.sh      EXPERIMENT THAT FAILS: Headscale gets a local DERP map whose
#                           only region is unreachable (no internet needed). Headscale
#                           starts and routes get approved, but peer paths come up
#                           asymmetric/flaky and 6 data-plane checks fail. Kept only so
#                           the negative result can be reproduced.
#                           (DERP "urls: []" with no paths at all makes Headscale exit:
#                           "initial DERPMap is empty, Headscale requires at least one entry")
#
# Default DERP=public fetches https://controlplane.tailscale.com/derpmap/default,
# exactly like the project's generator, so the host needs internet access.
#
# Needs on the host: docker, curl, jq. Publishes no host ports (REST calls go
# from the host straight to the container's bridge IP).
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
MODE=${MODE:-two}
DERP=${DERP:-public}
HS_IMAGE=headscale/headscale:0.29.1
TS_IMAGE=tailscale/tailscale:latest
CIDR_A=100.64.1.0/24
CIDR_B=100.64.2.0/24
TAG=tag:federation-relay
FAILS=0

say()  { printf '\n\033[1m=== %s\033[0m\n' "$*"; }
note() { printf -- '--- %s\n' "$*"; }
check() { # check "label" expected actual
  if [ "$2" = "$3" ]; then echo "PASS  $1 (got: $3)"; else echo "FAIL  $1 (expected: $2, got: $3)"; FAILS=$((FAILS+1)); fi; }
quiet() { grep -iv -e 'GRO' -e 'ethtool' -e 'IPv6 forwarding' -e 'may not work' -e 'ip-forwarding' || true; }

"$D/down.sh" >/dev/null

say "versions"
docker run --rm "$HS_IMAGE" version | head -2
docker run --rm --entrypoint tailscale "$TS_IMAGE" version | head -1
echo "docker $(docker version --format '{{.Server.Version}}'), kernel $(uname -r), MODE=$MODE DERP=$DERP"

# ---------------------------------------------------------------- headscale
say "networks + headscale (config shape copied from src/orchestrator/headscale.ts)"
docker network create fedspike-inet >/dev/null
docker network create --internal fedspike-link >/dev/null

gen_config() { # slug v4 v6
  local derp_urls
  if [ "$DERP" = dummy ]; then
    derp_urls=$'  urls: []\n  paths:\n    - /etc/headscale/derp-custom.yaml'
  else
    derp_urls=$'  urls:\n    - https://controlplane.tailscale.com/derpmap/default'
  fi
  cat <<EOF
---
server_url: http://fedspike-hs-$1:8080
listen_addr: 0.0.0.0:8080
metrics_listen_addr: 0.0.0.0:9090
noise:
  private_key_path: /etc/headscale/noise_private.key
prefixes:
  v4: $2
  v6: $3
  allocation: sequential
derp:
  server:
    enabled: false
$derp_urls
  auto_update_enabled: true
  update_frequency: 24h
database:
  type: sqlite
  sqlite:
    path: /etc/headscale/db.sqlite
dns:
  magic_dns: true
  base_domain: $1.tailnet.local
  nameservers:
    global:
      - 1.1.1.1
      - 8.8.8.8
log:
  level: info
policy:
  mode: database
EOF
}

declare -A HSIP KEY
start_hs() { # slug v4 v6
  local t=$1 tmp; tmp=$(mktemp -d "$D/.cfg-$t.XXXX")
  gen_config "$t" "$2" "$3" > "$tmp/config.yaml"
  cat > "$tmp/derp-custom.yaml" <<'EOF'
regions:
  900:
    regionid: 900
    regioncode: fedspike
    regionname: fedspike dummy (unreachable)
    nodes:
      - name: 900a
        regionid: 900
        hostname: derp.fedspike.invalid
        stunport: 0
        derpport: 0
EOF
  docker create --name fedspike-hs-$t --network fedspike-inet "$HS_IMAGE" serve >/dev/null
  docker cp "$tmp/." fedspike-hs-$t:/etc/headscale/ >/dev/null
  rm -rf "$tmp"
  docker start fedspike-hs-$t >/dev/null
  for _ in $(seq 1 30); do
    docker exec fedspike-hs-$t headscale health >/dev/null 2>&1 && break; sleep 1
  done
  docker exec fedspike-hs-$t headscale health >/dev/null 2>&1 || { docker logs fedspike-hs-$t 2>&1 | tail -5; echo "headscale $t did not start"; exit 1; }
  HSIP[$t]=$(docker inspect -f '{{(index .NetworkSettings.Networks "fedspike-inet").IPAddress}}' fedspike-hs-$t)
  KEY[$t]=$(docker exec fedspike-hs-$t headscale apikeys create --expiration 9999d | tail -1)
  docker exec fedspike-hs-$t headscale users create owner >/dev/null
  echo "hs-$t up at ${HSIP[$t]}  prefixes.v4=$2 v6=$3"
}
start_hs a $CIDR_A fd7a:115c:a1e0:1::/64
start_hs b $CIDR_B fd7a:115c:a1e0:2::/64

# api <a|b> METHOD PATH [json]  -> body, then a line "HTTP <code>"
api() {
  local t=$1 m=$2 p=$3 b=${4-}
  if [ -n "$b" ]; then
    curl -sS -w '\nHTTP %{http_code}\n' -X "$m" -H "Authorization: Bearer ${KEY[$t]}" -H 'Content-Type: application/json' "http://${HSIP[$t]}:8080$p" --data-binary "$b"
  else
    curl -sS -w '\nHTTP %{http_code}\n' -X "$m" -H "Authorization: Bearer ${KEY[$t]}" "http://${HSIP[$t]}:8080$p"
  fi
}
putpolicy() { api "$1" PUT /api/v1/policy "$(jq -n --arg p "$2" '{policy:$p}')"; }
EXP=$(date -u -d '+1 day' +%Y-%m-%dT%H:%M:%SZ)
userkey() { api "$1" POST /api/v1/preauthkey '{"user":"1","reusable":false,"ephemeral":false,"expiration":"'"$EXP"'"}' | head -1 | jq -r .preAuthKey.key; }
tagkey()  { api "$1" POST /api/v1/preauthkey '{"reusable":false,"ephemeral":false,"expiration":"'"$EXP"'","aclTags":["'$TAG'"]}' | head -1 | jq -r .preAuthKey.key; }
nodes()   { api "$1" GET /api/v1/node | head -1 | jq -c '.nodes[] | {id,name,ip:.ipAddresses[0],user:.user.name,tags,availableRoutes,approvedRoutes,subnetRoutes}'; }
other()   { [ "$1" = a ] && echo $CIDR_B || echo $CIDR_A; }
own()     { [ "$1" = a ] && echo $CIDR_A || echo $CIDR_B; }
policy()  { # tenant acls-json   (tagOwners with EMPTY owner list + autoApprover for the other tenant's CIDR)
  echo '{"tagOwners":{"'$TAG'":[]},"autoApprovers":{"routes":{"'"$(other "$1")"'":["'$TAG'"]}},"acls":'"$2"'}'; }
ALLOW_ALL='[{"action":"accept","src":["*"],"dst":["*:*"]}]'

# ---------------------------------------------------------------- Q4 policy
say "Q4: policy acceptance via PUT /api/v1/policy (policy.mode=database)"
note 'T1 tagOwners {"tag:federation-relay": []} + autoApprovers routes -> [tag]'
r=$(putpolicy a "$(policy a "$ALLOW_ALL")"); echo "$r"; check "empty tagOwners + tag auto-approver accepted" "HTTP 200" "$(echo "$r" | tail -1)"
note 'T2 autoApprovers routes -> ["*"]'
r=$(putpolicy a '{"tagOwners":{"'$TAG'":[]},"autoApprovers":{"routes":{"'$CIDR_B'":["*"]}},"acls":'"$ALLOW_ALL"'}'); echo "$r"; check '"*" approver rejected' "HTTP 500" "$(echo "$r" | tail -1)"
note 'T3 tag approver with NO tagOwners entry for the tag'
r=$(putpolicy a '{"autoApprovers":{"routes":{"'$CIDR_B'":["'$TAG'"]}},"acls":'"$ALLOW_ALL"'}'); echo "$r"; check 'undeclared tag rejected' "HTTP 500" "$(echo "$r" | tail -1)"
note 'same T1 policy through the CLI: headscale policy set -f'
policy a "$ALLOW_ALL" > "$D/.p.json"; docker cp "$D/.p.json" fedspike-hs-a:/tmp/p.json >/dev/null; rm -f "$D/.p.json"
docker exec fedspike-hs-a headscale policy set -f /tmp/p.json
putpolicy a "$(policy a "$ALLOW_ALL")" | tail -1
putpolicy b "$(policy b "$ALLOW_ALL")" | tail -1
note 'tagged pre-auth key via REST (no "user" field): POST /api/v1/preauthkey {"reusable":false,"ephemeral":false,"expiration":"...","aclTags":["tag:federation-relay"]}'
api a POST /api/v1/preauthkey '{"reusable":false,"ephemeral":false,"expiration":"'"$EXP"'","aclTags":["'$TAG'"]}' | sed -E 's/hskey-auth-[A-Za-z0-9_-]+/hskey-auth-<redacted>/'
note 'tagged pre-auth key via CLI: headscale preauthkeys create --tags tag:federation-relay --expiration 24h'
docker exec fedspike-hs-a headscale preauthkeys create --tags $TAG --expiration 24h -o json | jq -c '{id,acl_tags}'

# ---------------------------------------------------------------- devices
say "plain devices (kernel TUN, --accept-routes)"
ts_wait() { # container [socket]  -- wait until tailscaled answers on its socket
  local o
  for _ in $(seq 1 40); do
    o=$(docker exec "$1" tailscale ${2:+--socket=$2} status 2>&1 || true)
    echo "$o" | grep -qi 'failed to connect\|not running\|no such file' || return 0
    sleep 0.5
  done
  echo "tailscaled in $1 did not come up: $o"; exit 1; }
for t in a b; do
  docker run -d --name fedspike-dev-$t --hostname dev-$t --network fedspike-inet \
    --cap-add NET_ADMIN --device /dev/net/tun "$TS_IMAGE" tailscaled --statedir=/var/lib/tailscale >/dev/null
  ts_wait fedspike-dev-$t
  docker exec fedspike-dev-$t tailscale up --login-server http://fedspike-hs-$t:8080 --authkey "$(userkey $t)" --accept-routes --hostname dev-$t 2>&1 | quiet
  # TCP listener that tells the client which peer address the listener sees
  docker exec fedspike-dev-$t sh -c 'cat > /whoami.sh <<"EOF"
#!/bin/sh
echo "$(hostname) sees: $(ss -Htn | grep -E ":800[01] " | tr -s " " | head -1)"
EOF
chmod +x /whoami.sh'
  docker exec -d fedspike-dev-$t nc -lk -p 8000 -e /whoami.sh
  docker exec -d fedspike-dev-$t nc -lk -p 8001 -e /whoami.sh
done
IP_A=$(docker exec fedspike-dev-a tailscale ip -4); IP_B=$(docker exec fedspike-dev-b tailscale ip -4)
echo "dev-a=$IP_A dev-b=$IP_B"
check "Q1 dev-a address allocated from $CIDR_A" "100.64.1.1" "$IP_A"
check "Q1 dev-b address allocated from $CIDR_B" "100.64.2.1" "$IP_B"

# ---------------------------------------------------------------- test helpers
ping_rx() { docker exec fedspike-dev-$1 ping -c 3 -W 1 "$2" 2>&1 | grep -o '[0-9]* received' | cut -d' ' -f1 || true; }
ping_ok() { local n; n=$(ping_rx "$1" "$2"); [ "${n:-0}" -ge 1 ] && echo ok || echo fail; }
tcp()     { docker exec fedspike-dev-$1 sh -c "nc -w 2 $2 $3 </dev/null 2>/dev/null" | tail -1 || true; }
tcp_ok()  { [ -n "$(tcp "$@")" ] && echo ok || echo fail; }
wait_route() { # dev tenant cidr
  for _ in $(seq 1 40); do docker exec fedspike-dev-$1 ip route show table 52 | grep -q "^$2 " && return 0; sleep 0.5; done
  echo "WARN: dev-$1 never installed $2 in table 52"; }
matrix() {
  echo "  ping dev-a -> $IP_B      : $(ping_ok a $IP_B)"
  echo "  tcp  dev-a -> $IP_B:8000 : $(tcp a $IP_B 8000)"
  echo "  ping dev-b -> $IP_A      : $(ping_ok b $IP_A)"
  echo "  tcp  dev-b -> $IP_A:8000 : $(tcp b $IP_A 8000)"
}

# ================================================================ relay
if [ "$MODE" = two ]; then
  say "relay: TWO containers joined by the private fedspike-link network"
  for t in a b; do
    docker run -d --name fedspike-relay-$t --hostname relay-$t --network fedspike-inet \
      --cap-add NET_ADMIN --device /dev/net/tun --sysctl net.ipv4.ip_forward=1 \
      "$TS_IMAGE" tailscaled --statedir=/var/lib/tailscale >/dev/null
    docker network connect fedspike-link fedspike-relay-$t
    ts_wait fedspike-relay-$t
  done
  declare -A LINKIP LINKIF
  for t in a b; do
    LINKIP[$t]=$(docker inspect -f '{{(index .NetworkSettings.Networks "fedspike-link").IPAddress}}' fedspike-relay-$t)
    LINKIF[$t]=$(docker exec fedspike-relay-$t ip -o -4 addr show | awk -v ip="${LINKIP[$t]}" '$4 ~ "^"ip"/" {print $2}')
  done
  echo "link: relay-a ${LINKIP[a]} (${LINKIF[a]})  <->  relay-b ${LINKIP[b]} (${LINKIF[b]})"

  say "Q2 phase 1: tailscaled DEFAULT netfilter mode, --snat-subnet-routes=false, kernel routes over the link"
  docker exec fedspike-relay-a ip route add $CIDR_B via ${LINKIP[b]} dev ${LINKIF[a]}
  docker exec fedspike-relay-b ip route add $CIDR_A via ${LINKIP[a]} dev ${LINKIF[b]}
  for t in a b; do
    docker exec fedspike-relay-$t tailscale up --login-server http://fedspike-hs-$t:8080 --authkey "$(tagkey $t)" \
      --hostname relay-$t --advertise-routes="$(other $t)" --snat-subnet-routes=false 2>&1 | quiet
  done
  wait_route a $CIDR_B; wait_route b $CIDR_A
  note "Q1/Q4: nodes as Headscale sees them (tag from pre-auth key, route inside 100.64.0.0/10 auto-approved)"
  for t in a b; do echo "hs-$t:"; nodes $t; done
  check "Q4 relay-a route auto-approved" "[\"$CIDR_B\"]" "$(api a GET /api/v1/node | head -1 | jq -c '.nodes[] | select(.name=="relay-a") | .approvedRoutes')"
  check "Q4 relay-b route auto-approved" "[\"$CIDR_A\"]" "$(api b GET /api/v1/node | head -1 | jq -c '.nodes[] | select(.name=="relay-b") | .approvedRoutes')"
  check "Q4 relay-a carries tag" "[\"$TAG\"]" "$(api a GET /api/v1/node | head -1 | jq -c '.nodes[] | select(.name=="relay-a") | .tags')"
  note "ping dev-a -> $IP_B with default netfilter mode (expected: 0 received)"
  check "Q2 default netfilter mode: echo replies received (0 = does NOT forward)" "0" "$(ping_rx a $IP_B)"
  note "relay-b filter/ts-forward counters (the DROP rule is the one that counted the pings)"
  docker exec fedspike-relay-b iptables-legacy -nvL ts-forward

  say "Q2 phase 2: default netfilter mode + one manual ACCEPT inserted ahead of ts-forward"
  docker exec fedspike-relay-a iptables-legacy -I FORWARD 1 -i ${LINKIF[a]} -o tailscale0 -s $CIDR_B -d $CIDR_A -j ACCEPT
  docker exec fedspike-relay-b iptables-legacy -I FORWARD 1 -i ${LINKIF[b]} -o tailscale0 -s $CIDR_A -d $CIDR_B -j ACCEPT
  matrix
  check "Q2 netfilter=on + manual ACCEPT: ping a->b" ok "$(ping_ok a $IP_B)"
  note "...but tailscaled re-inserts its hook at position 1 whenever it reinstalls hooks (toggle off->on on relay-b):"
  docker exec fedspike-relay-b tailscale set --netfilter-mode=off 2>&1 | quiet; sleep 1
  docker exec fedspike-relay-b tailscale set --netfilter-mode=on 2>&1 | quiet; sleep 2
  docker exec fedspike-relay-b iptables-legacy -S FORWARD
  check "Q2 after hook reinstall: echo replies received (0 = manual ACCEPT now shadowed by ts-forward)" "0" "$(ping_rx a $IP_B)"

  say "Q3 control: SNAT left at tailscale's default (on) on both halves"
  for t in a b; do
    docker exec fedspike-relay-$t iptables-legacy -F FORWARD   # drop manual rules, tailscaled puts its own hook back
    docker exec fedspike-relay-$t tailscale set --netfilter-mode=off 2>&1 | quiet
    docker exec fedspike-relay-$t tailscale set --netfilter-mode=on --snat-subnet-routes=true 2>&1 | quiet
  done
  sleep 2
  docker exec fedspike-relay-a iptables-legacy -I FORWARD 1 -i ${LINKIF[a]} -o tailscale0 -j ACCEPT
  docker exec fedspike-relay-b iptables-legacy -I FORWARD 1 -i ${LINKIF[b]} -o tailscale0 -j ACCEPT
  docker exec fedspike-relay-a iptables-legacy -t nat -S ts-postrouting
  check "Q3 SNAT on: echo replies received (0 = broken)" "0" "$(ping_rx a $IP_B)"
  check "Q3 SNAT on: tcp a->b (fail = broken)" "fail" "$(tcp_ok a $IP_B 8000)"

  say "FINAL RECIPE: --netfilter-mode=off --snat-subnet-routes=false, FORWARD policy DROP + two stateless ACCEPTs"
  for t in a b; do
    docker exec fedspike-relay-$t tailscale set --netfilter-mode=off --snat-subnet-routes=false 2>&1 | quiet
    docker exec fedspike-relay-$t sh -c "
      iptables-legacy -F FORWARD
      iptables-legacy -P FORWARD DROP
      iptables-legacy -A FORWARD -i tailscale0 -o ${LINKIF[$t]} -s $(own $t) -d $(other $t) -j ACCEPT
      iptables-legacy -A FORWARD -i ${LINKIF[$t]} -o tailscale0 -s $(other $t) -d $(own $t) -j ACCEPT"
  done
  sleep 1
  for t in a b; do
    echo "relay-$t:"; docker exec fedspike-relay-$t sh -c 'iptables-legacy -S; iptables-legacy -t nat -S | grep -v DOCKER; echo "main:"; ip route | grep 100.64; echo "table 52:"; ip route show table 52; sysctl net.ipv4.ip_forward net.ipv4.conf.all.rp_filter' | sed 's/^/    /'
  done
  RELAY_STATUS() { docker exec fedspike-relay-$1 tailscale status; }
else
  say "relay: ONE container, two tailscaled processes (separate state/socket/tun/port), no private link"
  docker run -d --name fedspike-relay-single --hostname relay-single --network fedspike-inet \
    --cap-add NET_ADMIN --device /dev/net/tun --sysctl net.ipv4.ip_forward=1 "$TS_IMAGE" sleep infinity >/dev/null
  port=41641
  for t in a b; do
    docker exec -d fedspike-relay-single sh -c "tailscaled --tun=ts-$t --socket=/run/ts-$t.sock --statedir=/var/lib/ts-$t --port=$port > /var/log/ts-$t.log 2>&1"
    ts_wait fedspike-relay-single /run/ts-$t.sock
    docker exec fedspike-relay-single tailscale --socket=/run/ts-$t.sock up --login-server http://fedspike-hs-$t:8080 --authkey "$(tagkey $t)" \
      --hostname relay-$t --advertise-routes="$(other $t)" --snat-subnet-routes=false --netfilter-mode=off --accept-dns=false 2>&1 | quiet
    port=$((port+1))
  done
  docker exec fedspike-relay-single sh -c "
    iptables-legacy -P FORWARD DROP
    iptables-legacy -A FORWARD -i ts-a -o ts-b -s $CIDR_A -d $CIDR_B -j ACCEPT
    iptables-legacy -A FORWARD -i ts-b -o ts-a -s $CIDR_B -d $CIDR_A -j ACCEPT"
  wait_route a $CIDR_B; wait_route b $CIDR_A
  for t in a b; do echo "hs-$t:"; nodes $t; done
  check "Q4 relay-a route auto-approved" "[\"$CIDR_B\"]" "$(api a GET /api/v1/node | head -1 | jq -c '.nodes[] | select(.name=="relay-a") | .approvedRoutes')"
  check "Q4 relay-b route auto-approved" "[\"$CIDR_A\"]" "$(api b GET /api/v1/node | head -1 | jq -c '.nodes[] | select(.name=="relay-b") | .approvedRoutes')"
  docker exec fedspike-relay-single sh -c 'ps | grep "[t]ailscaled"; iptables-legacy -S; echo "ip rule:"; ip rule; echo "table 52 (shared by both tailscaleds):"; ip route show table 52; echo "main:"; ip route' | sed 's/^/    /'
  RELAY_STATUS() { docker exec fedspike-relay-single tailscale --socket=/run/ts-$1.sock status; }
fi

# ================================================================ success tests
say "SUCCESS TESTS (allow-all ACLs on both tenants)"
matrix
check "ping dev-a -> dev-b" ok "$(ping_ok a $IP_B)"
check "ping dev-b -> dev-a" ok "$(ping_ok b $IP_A)"
check "Q3 dev-b sees dev-a's real tailnet source address" "yes" "$(tcp a $IP_B 8000 | grep -q "$IP_A\]:" && echo yes || echo no)"
check "Q3 dev-a sees dev-b's real tailnet source address" "yes" "$(tcp b $IP_A 8000 | grep -q "$IP_B\]:" && echo yes || echo no)"

say "path evidence"
for t in a b; do
  o=$([ $t = a ] && echo $IP_B || echo $IP_A)
  echo "dev-$t: tailscale status";            docker exec fedspike-dev-$t tailscale status | sed 's/^/    /'
  echo "dev-$t: ip route show table 52";      docker exec fedspike-dev-$t ip route show table 52 | sed 's/^/    /'
  echo "dev-$t: ip route get $o";             docker exec fedspike-dev-$t ip route get $o | head -1 | sed 's/^/    /'
  echo "dev-$t: peer AllowedIPs/PrimaryRoutes"; docker exec fedspike-dev-$t tailscale status --json | jq -c '.Peer[] | {HostName,Tags,PrimaryRoutes,AllowedIPs,CurAddr}' | sed 's/^/    /'
  echo "dev-$t: traceroute -n $o";            docker exec fedspike-dev-$t traceroute -n -w 1 -q 1 -m 4 $o 2>&1 | tail -n +2 | sed 's/^/    /'
  echo "relay-$t: tailscale status";          RELAY_STATUS $t | sed 's/^/    /'
done
note "tailscale ping from dev-a to $IP_B (disco and TSMP are answered by relay-a, the subnet router; --icmp is end to end)"
docker exec fedspike-dev-a tailscale ping -c 1 --timeout 3s $IP_B 2>&1 | sed 's/^/    /' || true
docker exec fedspike-dev-a tailscale ping --tsmp -c 1 --timeout 3s $IP_B 2>&1 | sed 's/^/    /' || true
docker exec fedspike-dev-a tailscale ping --icmp -c 1 --timeout 3s $IP_B 2>&1 | sed 's/^/    /' || true

# ================================================================ ACLs on the real source
say "Q3: B's ACL matching on the A-side source address"
note "B: accept src 100.64.1.99 -> $IP_B:8000   (dev-a is $IP_A, so it must be refused)"
putpolicy b "$(policy b '[{"action":"accept","src":["100.64.1.99"],"dst":["'$IP_B':8000"]}]')" | tail -1; sleep 3
check "tcp dev-a -> dev-b:8000 with non-matching src rule" "fail" "$(tcp_ok a $IP_B 8000)"
note "B: accept src $IP_A -> $IP_B:8000 only"
putpolicy b "$(policy b '[{"action":"accept","src":["'$IP_A'"],"dst":["'$IP_B':8000"]}]')" | tail -1; sleep 3
echo "dev-b packet filter: $(docker exec fedspike-dev-b tailscale debug netmap 2>/dev/null | jq -c '.PacketFilter')"
check "tcp dev-a -> dev-b:8000 with matching src rule" "ok" "$(tcp_ok a $IP_B 8000)"
check "tcp dev-a -> dev-b:8001 (port not in rule)" "fail" "$(tcp_ok a $IP_B 8001)"
check "tcp dev-b -> dev-a:8000 (B's ACL has no rule towards A's CIDR)" "fail" "$(tcp_ok b $IP_A 8000)"
note "restore allow-all on B; then A: accept src $IP_A -> $IP_B:8000 only (enforced on relay-a's tailscaled)"
putpolicy b "$(policy b "$ALLOW_ALL")" | tail -1
putpolicy a "$(policy a '[{"action":"accept","src":["'$IP_A'"],"dst":["'$IP_B':8000"]}]')" | tail -1; sleep 3
check "A-side ACL: tcp dev-a -> dev-b:8000" "ok" "$(tcp_ok a $IP_B 8000)"
check "A-side ACL: tcp dev-a -> dev-b:8001" "fail" "$(tcp_ok a $IP_B 8001)"
check "A-side ACL: tcp dev-b -> dev-a:8000 (A has no rule admitting B sources)" "fail" "$(tcp_ok b $IP_A 8000)"
putpolicy a "$(policy a "$ALLOW_ALL")" | tail -1; sleep 3
check "after restoring allow-all: tcp dev-b -> dev-a:8000" "ok" "$(tcp_ok b $IP_A 8000)"

say "RESULT"
if [ "$FAILS" -eq 0 ]; then echo "all checks passed (MODE=$MODE DERP=$DERP). Environment left running; ./down.sh removes it."
else echo "$FAILS check(s) FAILED (MODE=$MODE DERP=$DERP)"; exit 1; fi
