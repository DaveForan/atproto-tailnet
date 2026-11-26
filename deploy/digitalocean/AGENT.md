# DigitalOcean Autonomous Deployment Guide

Machine-readable instructions for an AI agent. The agent deploys atproto-tailnet on DigitalOcean without human help.

## Overview

- **What**: A single Droplet that runs the full stack (TypeScript service, Rust coordinator, PostgreSQL, and Caddy)
- **Provider**: DigitalOcean (compute and DNS in one API)
- **TLS strategy**: `digitalocean` -- DNS-01 wildcard with the DO API token
- **Compose file**: `docker-compose.coordinator.yml`
- **Cost estimate**: ~$18-24/month ($18 Droplet + $3.60 optional backups + $0 DNS)
- **Human guide**: "First deployment on DigitalOcean" in [docs/deployment.md](../../docs/deployment.md#first-deployment-on-digitalocean)

## Prerequisites

| Prerequisite | Verification command |
|---|---|
| DigitalOcean account with API token (read+write scope) | `doctl account get` |
| `doctl` CLI installed and authenticated | `doctl auth init --access-token $DO_AUTH_TOKEN` |
| Domain added to DO DNS | `doctl compute domain list` |
| SSH key uploaded to DO | `doctl compute ssh-key list` |
| Git repo accessible from the Droplet | N/A |
| Bluesky DID of the instance operator | See the `OPERATOR_DIDS` row below |

Only `doctl` on your workstation needs the full read+write token. It uses this token to create the Droplet, the firewall, and the DNS records.

### If you use the DigitalOcean MCP server instead of `doctl`

You can do the DigitalOcean API steps with the DigitalOcean MCP tools. Map each `doctl` command to the matching MCP tool:

- Droplet create, get, and delete.
- Domain record create, list, and delete.
- Cloud Firewall create and delete.
- SSH key list.

The MCP server does not give shell access to the Droplet. Steps that use `ssh root@$DROPLET_IP` need a shell on your workstation with the SSH key. These steps write `.env`, run `droplet-setup.sh`, generate `ATPROTO_PRIVATE_KEY`, and start the stack. Do not skip them.

Do not print secrets (`SESSION_SECRET`, `POSTGRES_PASSWORD`, `COORDINATOR_API_KEY`, `FEDERATION_KEY_ENCRYPTION_KEY`, `ATPROTO_PRIVATE_KEY`, `DO_AUTH_TOKEN`) in your output. Generate them and write them directly to `.env` on the Droplet.

Ask the user for the operator's Bluesky handle or DID before you write `OPERATOR_DIDS`. To convert a handle to a DID, run `curl "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=<handle>"`. Show the DID to the user and get confirmation.

## Required Inputs

### Provided by operator

| Variable | Description | Example |
|---|---|---|
| `DO_AUTH_TOKEN` | DigitalOcean API token (read+write), for `doctl` on your workstation only | `dop_v1_abc123...` |
| `DO_DNS_TOKEN` | DigitalOcean API token for Caddy on the Droplet. Use a custom-scoped token with domain (DNS record) read/write access only, if possible | `dop_v1_def456...` |
| `OPERATOR_DIDS` | Comma-separated DIDs of the instance operators. You must set it before the first sign-in | `did:plc:abc123...` |
| `ADMIN_IP` | Public IP address that can connect with SSH | `203.0.113.10` |
| `DOMAIN` | Base domain managed in DO DNS | `example.com` |
| `APP_SUBDOMAIN` | Subdomain for the web UI | `tailnets` (gives `tailnets.example.com`) |
| `TENANT_SUBDOMAIN` | Subdomain prefix for the tenant wildcard | `ts` (gives `*.ts.example.com`) |
| `SSH_KEY_FINGERPRINT` | Fingerprint from `doctl compute ssh-key list` | `ab:cd:ef:...` |
| `REGION` | DigitalOcean region slug | `nyc1` |
| `DROPLET_SIZE` | Droplet size slug (2 GB RAM minimum) | `s-2vcpu-2gb` |
| `REPO_URL` | Git clone URL for the repository | `https://github.com/org/atproto-tailnet.git` |
| `BRANCH` | Git branch to deploy | `main` |

### Generated secrets (generate them at deploy time)

| Variable | Generation command |
|---|---|
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `POSTGRES_PASSWORD` | `openssl rand -hex 16` |
| `COORDINATOR_API_KEY` | `openssl rand -hex 32` |
| `FEDERATION_KEY_ENCRYPTION_KEY` | `openssl rand -hex 32` |
| `ATPROTO_PRIVATE_KEY` | See step 8. Generate it on the Droplet after `.env` exists |

The app does not start in production if `SESSION_SECRET` or `COORDINATOR_API_KEY` has fewer than 32 characters. It also does not start if the value contains `change-me` or `changeme`. The coordinator applies the same rule to its admin key (`COORDINATOR_API_KEY`).

To find the DID of a Bluesky account, use this command:

```sh
curl "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=you.bsky.social"
```

Only operators, and the "tailnet creators" that an operator designates, get a tailnet. All other users who sign in see a "no access" view. This view shows their pending invitations and a "Request to join" button for the default tailnet. The first tailnet that an operator creates becomes the default tailnet. The default tailnet accepts join requests. If `OPERATOR_DIDS` is empty, the app logs a loud warning and nobody can create a tailnet.

## Deployment Steps

### 1. Create the Droplet

```sh
doctl compute droplet create atproto-tailnet \
  --region "$REGION" \
  --size "$DROPLET_SIZE" \
  --image ubuntu-22-04-x64 \
  --ssh-keys "$SSH_KEY_FINGERPRINT" \
  --tag-names atproto-tailnet \
  --wait
```

### 2. Obtain the Droplet IP

```sh
DROPLET_IP=$(doctl compute droplet get atproto-tailnet --format PublicIPv4 --no-header)
echo "$DROPLET_IP"
```

If the IP is empty, the Droplet is still provisioning. Retry with a 5s backoff.

### 3. Create DNS records

A record for the app domain:
```sh
doctl compute domain records create "$DOMAIN" \
  --record-type A \
  --record-name "$APP_SUBDOMAIN" \
  --record-data "$DROPLET_IP" \
  --record-ttl 300
```

A record for the shared control URL (all devices use `https://control.$DOMAIN` as login server):
```sh
doctl compute domain records create "$DOMAIN" \
  --record-type A \
  --record-name "control" \
  --record-data "$DROPLET_IP" \
  --record-ttl 300
```

A record for the built-in DERP relay:
```sh
doctl compute domain records create "$DOMAIN" \
  --record-type A \
  --record-name "derp" \
  --record-data "$DROPLET_IP" \
  --record-ttl 300
```

Wildcard A record for tenant subdomains:
```sh
doctl compute domain records create "$DOMAIN" \
  --record-type A \
  --record-name "*.$TENANT_SUBDOMAIN" \
  --record-data "$DROPLET_IP" \
  --record-ttl 300
```

Optional: wildcard A record for HTTPS service names (ADR-0038). Caddy gets the
`*.svc.$TENANT_SUBDOMAIN` certificate through DNS-01 with or without it. With
it, a service name gets the same 404 as an unknown name from the internet:
```sh
doctl compute domain records create "$DOMAIN" \
  --record-type A \
  --record-name "*.svc.$TENANT_SUBDOMAIN" \
  --record-data "$DROPLET_IP" \
  --record-ttl 300
```

### 4. Wait for SSH access

```sh
until ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 root@"$DROPLET_IP" true 2>/dev/null; do
  sleep 5
done
```

### 5. Install Docker on the Droplet

```sh
ssh root@"$DROPLET_IP" 'bash -s' <<'REMOTE'
set -euo pipefail
apt-get update -y
apt-get upgrade -y
if ! command -v docker &>/dev/null; then
  # Docker's signed apt repository (not the get.docker.com script). The key
  # fingerprint is checked before apt trusts the repository.
  apt-get install -y ca-certificates curl gnupg
  DOCKER_OS="$(. /etc/os-release && echo "$ID")"
  DOCKER_CODENAME="$(. /etc/os-release && echo "$VERSION_CODENAME")"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${DOCKER_OS}/gpg" -o /etc/apt/keyrings/docker.asc
  DOCKER_KEY_FPR="$(gpg --show-keys --with-colons /etc/apt/keyrings/docker.asc | awk -F: '$1 == "fpr" { print $10; exit }')"
  if [ "$DOCKER_KEY_FPR" != "9DC858229FC7DD38854AE2D88D81803C0EBFCD88" ]; then
    echo "ERROR: unexpected Docker apt key fingerprint: $DOCKER_KEY_FPR" >&2
    rm -f /etc/apt/keyrings/docker.asc
    exit 1
  fi
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${DOCKER_OS} ${DOCKER_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
fi
docker compose version || apt-get install -y docker-compose-plugin
apt-get install -y git
REMOTE
```

### 6. Clone the repository

```sh
ssh root@"$DROPLET_IP" "git clone --branch $BRANCH $REPO_URL /opt/atproto-tailnet"
```

### 7. Generate secrets and write .env

Generate all secrets locally. Then write the .env file to the Droplet in one operation. Substitute all variables before you send the file.

```sh
SESSION_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 16)
COORDINATOR_API_KEY=$(openssl rand -hex 32)
FEDERATION_KEY_ENCRYPTION_KEY=$(openssl rand -hex 32)

APP_DOMAIN="${APP_SUBDOMAIN}.${DOMAIN}"
BASE_DOMAIN="${TENANT_SUBDOMAIN}.${DOMAIN}"

ssh root@"$DROPLET_IP" "cat > /opt/atproto-tailnet/.env" <<EOF
# Database
POSTGRES_USER=atproto_tailnet
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=atproto_tailnet
DATABASE_URL=postgresql://atproto_tailnet:${POSTGRES_PASSWORD}@postgres:5432/atproto_tailnet

# TS service
SESSION_SECRET=${SESSION_SECRET}
PORT=3000
PUBLIC_URL=https://${APP_DOMAIN}
BASE_DOMAIN=${BASE_DOMAIN}
CONTROL_DOMAIN=control.${DOMAIN}
DERP_DOMAIN=derp.${DOMAIN}
LOG_LEVEL=info
FEDERATION_KEY_ENCRYPTION_KEY=${FEDERATION_KEY_ENCRYPTION_KEY}

# Instance operators (must be set before the first sign-in)
OPERATOR_DIDS=${OPERATOR_DIDS}

# Coordinator
COORDINATOR_URL=http://coordinator:9443
COORDINATOR_API_KEY=${COORDINATOR_API_KEY}
COORD_LISTEN=0.0.0.0:9443
COORD_ADMIN_KEY=${COORDINATOR_API_KEY}

# Caddy
CADDY_ADMIN_URL=http://10.250.250.2:2019
APP_DOMAIN=${APP_DOMAIN}

# TLS — DigitalOcean DNS-01 wildcard
TLS_STRATEGY=digitalocean
DO_AUTH_TOKEN=${DO_DNS_TOKEN}
CADDY_DNS_PLUGINS=github.com/caddy-dns/digitalocean
EOF

ssh root@"$DROPLET_IP" "chmod 600 /opt/atproto-tailnet/.env"
```

Do not set `FEDERATION_ENABLED`. Federation is off by default. It is deferred (ADR-0033). Its relay containers need the Docker socket, and the stack does not send traffic between instances, so federation links carry no traffic. The app still uses `FEDERATION_KEY_ENCRYPTION_KEY` for collective signing keys and credentials.

### 8. Generate the AT Protocol OAuth key

Production sign-in fails without `ATPROTO_PRIVATE_KEY`. The app loads it with `JoseKey.fromImportable`. Use a one-line ES256 (P-256) private JWK that starts with `{`. A PKCS8 PEM also works, but it has many lines, so use the JWK.

This command uses the `jose` dependency in the app image. Run it on the Droplet after `.env` exists:

```sh
ssh root@"$DROPLET_IP" 'bash -s' <<'REMOTE'
set -euo pipefail
cd /opt/atproto-tailnet
KEY=$(docker compose -f docker-compose.coordinator.yml run --rm --no-deps --entrypoint node app \
  --input-type=module -e "import {generateKeyPair,exportJWK} from 'jose'; const {privateKey}=await generateKeyPair('ES256',{extractable:true}); console.log(JSON.stringify({...await exportJWK(privateKey),alg:'ES256'}))")
echo "ATPROTO_PRIVATE_KEY='${KEY}'" >> .env
REMOTE
```

The result in `.env` is one line in single quotes: `ATPROTO_PRIVATE_KEY='{"kty":"EC",...}'`.

### 9. Configure the cloud firewall

Docker-published ports (80, 443) bypass `ufw`. `ufw` alone does not protect them. Use a DigitalOcean Cloud Firewall:

```sh
doctl compute firewall create \
  --name atproto-tailnet-fw \
  --tag-names atproto-tailnet \
  --inbound-rules "protocol:tcp,ports:22,address:${ADMIN_IP}/32 protocol:tcp,ports:80,address:0.0.0.0/0,address:::/0 protocol:tcp,ports:443,address:0.0.0.0/0,address:::/0 protocol:udp,ports:443,address:0.0.0.0/0,address:::/0 protocol:udp,ports:3478,address:0.0.0.0/0,address:::/0" \
  --outbound-rules "protocol:tcp,ports:all,address:0.0.0.0/0,address:::/0 protocol:udp,ports:all,address:0.0.0.0/0,address:::/0 protocol:icmp,address:0.0.0.0/0,address:::/0"
```

The compose file does not publish the coordinator port (9443) or Postgres. They use `expose` only. Postgres is only on the `internal` network. Caddy is only on the `edge` network. For more hardening steps, see "Droplet hardening" in [docs/deployment.md](../../docs/deployment.md#droplet-hardening).

### 10. Build and start the stack

```sh
ssh root@"$DROPLET_IP" 'bash -s' <<'REMOTE'
cd /opt/atproto-tailnet
docker compose -f docker-compose.coordinator.yml build
docker compose -f docker-compose.coordinator.yml up -d
REMOTE
```

### 11. Wait for health check

Poll the health endpoint of the app from inside the `app` container. The compose file does not publish port 3000 on the host.

```sh
for i in $(seq 1 60); do
  if ssh root@"$DROPLET_IP" "cd /opt/atproto-tailnet && docker compose -f docker-compose.coordinator.yml exec -T app wget -qO- http://localhost:3000/health" >/dev/null 2>&1; then
    echo "Health check passed"
    break
  fi
  sleep 5
done
```

### 12. Verify HTTPS externally

Wait for DNS propagation (up to 300s for DO DNS). Caddy also needs time to get the TLS certificate at the first start. Then verify:

```sh
for i in $(seq 1 60); do
  if curl -sf "https://${APP_DOMAIN}/health" >/dev/null 2>&1; then
    echo "HTTPS verified"
    break
  fi
  sleep 5
done
```

### 13. Sign in as the operator

The operator must sign in first after the deploy. Open `https://${APP_DOMAIN}` and sign in with the Bluesky account in `OPERATOR_DIDS`. Then create the first tailnet. This tailnet becomes the default tailnet. Other users can then send join requests to it.

A sign-in does not create a tailnet automatically.

### 14. Connect Claude (optional)

In Claude, add a custom connector with this URL: `https://<APP_DOMAIN>/mcp`. The connector uses OAuth sign-in with Bluesky. For more data, see [docs/site/guides/mcp.md](../../docs/site/guides/mcp.md).

## Verification

### Health check

```sh
curl -f "https://${APP_DOMAIN}/health"
# Expected: {"status":"ok"} with HTTP 200
```

Caddy sets HSTS on `APP_DOMAIN`. Tenant subdomains (`<slug>.BASE_DOMAIN`) expose only `/key` and `/ts2021` from the coordinator. The Caddy admin API listens only on the private `caddy_admin` network (10.250.250.0/29), which only the `app` container joins. The `app` and `coordinator` containers run as non-root users.

### Operator check

```sh
ssh root@"$DROPLET_IP" "grep '^OPERATOR_DIDS=' /opt/atproto-tailnet/.env"
ssh root@"$DROPLET_IP" "cd /opt/atproto-tailnet && docker compose -f docker-compose.coordinator.yml logs app | grep -i 'OPERATOR_DIDS IS EMPTY'"
# Expected: a DID on the first line; no output from the second command
```

### DNS resolution

```sh
dig +short "${APP_DOMAIN}"
# Expected: $DROPLET_IP

dig +short "test.${BASE_DOMAIN}"
# Expected: $DROPLET_IP
```

### TLS certificate validity

```sh
echo | openssl s_client -connect "${APP_DOMAIN}:443" -servername "${APP_DOMAIN}" 2>/dev/null | openssl x509 -noout -dates -subject
# Expected: valid dates, subject matching the domain
```

### Wildcard TLS

```sh
echo | openssl s_client -connect "anything.${BASE_DOMAIN}:443" -servername "anything.${BASE_DOMAIN}" 2>/dev/null | openssl x509 -noout -text | grep -A1 "Subject Alternative Name"
# Expected: *.ts.example.com in the SAN list
```

The gateway certificate covers HTTPS service names only (ADR-0038). Check the
copy that the relay reads:

```sh
ssh root@"$DROPLET_IP" "cd /opt/atproto-tailnet && docker compose -f docker-compose.coordinator.yml exec relay sh -c 'ls -l /certs'"
# Expected: tls.key -rw------- coord, tls.crt -rw-r--r-- coord
ssh root@"$DROPLET_IP" "cd /opt/atproto-tailnet && docker compose -f docker-compose.coordinator.yml logs relay | grep gateway"
# Expected: "gateway enabled" or "gateway certificate arrived", with service_domain svc.<BASE_DOMAIN>
```

### Service logs

```sh
ssh root@"$DROPLET_IP" "cd /opt/atproto-tailnet && docker compose -f docker-compose.coordinator.yml logs --tail 50"
```

## Backups

Back up these two Docker volumes:

- `pgdata` -- the PostgreSQL data.
- `coord_data` -- the coordinator Noise control key (`COORD_CONTROL_KEY_PATH=/var/lib/coordinator/control.key`).

If you lose `coord_data`, all devices must register and connect again.

## Teardown

### 1. Stop services

The `-v` flag deletes all volumes, including `pgdata` and `coord_data`. Make a backup first if you need the data.

```sh
ssh root@"$DROPLET_IP" "cd /opt/atproto-tailnet && docker compose -f docker-compose.coordinator.yml down -v"
```

### 2. Delete the Droplet and the firewall

```sh
doctl compute droplet delete atproto-tailnet --force
doctl compute firewall list --format ID,Name --no-header | awk '$2=="atproto-tailnet-fw"{print $1}' | xargs -r -n1 doctl compute firewall delete --force
```

### 3. Delete DNS records

```sh
# Get record IDs
APP_RECORD_ID=$(doctl compute domain records list "$DOMAIN" --format ID,Name --no-header | grep "^.*${APP_SUBDOMAIN}$" | awk '{print $1}')
WILDCARD_RECORD_ID=$(doctl compute domain records list "$DOMAIN" --format ID,Name --no-header | grep "^.*\*.${TENANT_SUBDOMAIN}$" | awk '{print $1}')

doctl compute domain records delete "$DOMAIN" "$APP_RECORD_ID" --force
doctl compute domain records delete "$DOMAIN" "$WILDCARD_RECORD_ID" --force
```

## Troubleshooting

### TLS certificate not issuing

**Symptom**: Caddy logs show `failed to solve challenge` or `DNS record not found`.

**Cause**: The `DO_AUTH_TOKEN` value in `.env` on the Droplet has no domain write scope, or the DNS records did not propagate yet.

**Fix**:
```sh
# Check Caddy logs for ACME errors
ssh root@"$DROPLET_IP" "cd /opt/atproto-tailnet && docker compose -f docker-compose.coordinator.yml logs caddy | grep -i 'error\|acme\|tls\|challenge'"

# Verify the domain is in DO DNS (workstation token)
doctl compute domain records list "$DOMAIN"
# Verify the token in .env on the Droplet can read the domain records
ssh root@"$DROPLET_IP" 'curl -sf -H "Authorization: Bearer $(grep ^DO_AUTH_TOKEN= /opt/atproto-tailnet/.env | cut -d= -f2-)" https://api.digitalocean.com/v2/domains/'"$DOMAIN"'/records >/dev/null && echo OK'

# Verify the TLS strategy mount is correct
ssh root@"$DROPLET_IP" "docker exec \$(docker ps -qf name=caddy) ls /etc/caddy/tls-strategy/"
# Expected: global.caddy  site.caddy
```

### DNS propagation delay

**Symptom**: `dig` returns no result or an old IP, and curl gets "connection refused".

**Cause**: The DO DNS TTL did not expire yet. The default TTL is 300s.

**Fix**: Wait up to 5 minutes. Then verify with:
```sh
dig +short "${APP_DOMAIN}" @ns1.digitalocean.com
```

### Coordinator not starting

**Symptom**: The `coordinator` container exits or the health check fails.

**Fix**:
```sh
ssh root@"$DROPLET_IP" "cd /opt/atproto-tailnet && docker compose -f docker-compose.coordinator.yml logs coordinator"
# Check for: DATABASE_URL connection errors, port conflicts, build failures
```

### App returns 502 Bad Gateway

**Symptom**: Caddy runs but returns 502.

**Cause**: The `app` container is not healthy, or the coordinator is not ready.

**Fix**:
```sh
ssh root@"$DROPLET_IP" "cd /opt/atproto-tailnet && docker compose -f docker-compose.coordinator.yml ps"
# All services should show "healthy" or "Up"

# Check app logs specifically
ssh root@"$DROPLET_IP" "cd /opt/atproto-tailnet && docker compose -f docker-compose.coordinator.yml logs app"
```

### Database connection errors

**Symptom**: The app or coordinator logs show `connection refused` to postgres.

**Fix**:
```sh
# Check postgres is running and healthy
ssh root@"$DROPLET_IP" "cd /opt/atproto-tailnet && docker compose -f docker-compose.coordinator.yml ps postgres"

# Verify POSTGRES_PASSWORD in .env matches DATABASE_URL
ssh root@"$DROPLET_IP" "grep POSTGRES_PASSWORD /opt/atproto-tailnet/.env"
```

### Out of memory

**Symptom**: The system kills Docker containers for out-of-memory (check `dmesg` or `docker inspect`).

**Fix**: Upgrade to a larger Droplet:
```sh
doctl compute droplet-action resize atproto-tailnet --size s-2vcpu-4gb --wait
```

### Caddy build fails (DNS plugin)

**Symptom**: `docker compose build caddy` fails with xcaddy errors.

**Cause**: The `CADDY_DNS_PLUGINS` env var is missing or has a spelling error.

**Fix**: Verify that `.env` contains exactly:
```
CADDY_DNS_PLUGINS=github.com/caddy-dns/digitalocean
```

### Sign-in fails or the user has no tailnet

**Symptom**: The OAuth sign-in fails, or the operator sees the "no access" view.

**Fix**:
- Make sure that `.env` contains a one-line `ATPROTO_PRIVATE_KEY='{"kty":"EC",...}'` (see step 8).
- Make sure that `OPERATOR_DIDS` contains the DID of the operator account.
- Restart the app after you change `.env`:
```sh
ssh root@"$DROPLET_IP" "cd /opt/atproto-tailnet && docker compose -f docker-compose.coordinator.yml up -d app"
```
