# DigitalOcean Autonomous Deployment Guide

Machine-readable instructions for an AI agent to deploy atproto-tailnet on DigitalOcean with zero human intervention.

## Overview

- **What**: Single Droplet running the full coordinator-mode stack (TypeScript service + Rust coordinator + PostgreSQL + Caddy)
- **Provider**: DigitalOcean (compute + DNS in one API)
- **TLS strategy**: `digitalocean` -- DNS-01 wildcard via DO API token
- **Compose file**: `docker-compose.coordinator.yml`
- **Cost estimate**: ~$18-24/month ($18 Droplet + $3.60 backups optional + $0 DNS)

## Prerequisites

| Prerequisite | Verification command |
|---|---|
| DigitalOcean account with API token (read+write scope) | `doctl account get` |
| `doctl` CLI installed and authenticated | `doctl auth init --access-token $DO_AUTH_TOKEN` |
| Domain added to DO DNS | `doctl compute domain list` |
| SSH key uploaded to DO | `doctl compute ssh-key list` |
| Git repo accessible from the Droplet | N/A |

## Required Inputs

### Provided by operator

| Variable | Description | Example |
|---|---|---|
| `DO_AUTH_TOKEN` | DigitalOcean API token (read+write) | `dop_v1_abc123...` |
| `DOMAIN` | Base domain managed in DO DNS | `example.com` |
| `APP_SUBDOMAIN` | Subdomain for the web UI | `tailnets` (produces `tailnets.example.com`) |
| `TENANT_SUBDOMAIN` | Subdomain prefix for tenant wildcard | `ts` (produces `*.ts.example.com`) |
| `SSH_KEY_FINGERPRINT` | Fingerprint from `doctl compute ssh-key list` | `ab:cd:ef:...` |
| `REGION` | DigitalOcean region slug | `nyc1` |
| `DROPLET_SIZE` | Droplet size slug (2 GB RAM minimum) | `s-2vcpu-2gb` |
| `REPO_URL` | Git clone URL for the repository | `https://github.com/org/atproto-tailnet.git` |
| `BRANCH` | Git branch to deploy | `main` |

### Generated secrets (generate at deploy time)

| Variable | Generation command |
|---|---|
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `POSTGRES_PASSWORD` | `openssl rand -hex 16` |
| `COORDINATOR_API_KEY` | `openssl rand -hex 32` |
| `FEDERATION_KEY_ENCRYPTION_KEY` | `openssl rand -hex 32` |

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

### 2. Get the Droplet IP

```sh
DROPLET_IP=$(doctl compute droplet get atproto-tailnet --format PublicIPv4 --no-header)
echo "$DROPLET_IP"
```

Retry with 5s backoff if the IP is empty (Droplet still provisioning).

### 3. Create DNS records

A record for the app domain:
```sh
doctl compute domain records create "$DOMAIN" \
  --record-type A \
  --record-name "$APP_SUBDOMAIN" \
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
  curl -fsSL https://get.docker.com | sh
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

Generate all secrets locally, then write the .env file to the Droplet in one shot. Substitute all variables before sending.

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
LOG_LEVEL=info
FEDERATION_KEY_ENCRYPTION_KEY=${FEDERATION_KEY_ENCRYPTION_KEY}

# Coordinator
COORDINATOR_URL=http://coordinator:9443
COORDINATOR_API_KEY=${COORDINATOR_API_KEY}
COORD_LISTEN=0.0.0.0:9443
COORD_ADMIN_KEY=${COORDINATOR_API_KEY}

# Caddy
CADDY_ADMIN_URL=http://caddy:2019
APP_DOMAIN=${APP_DOMAIN}

# TLS — DigitalOcean DNS-01 wildcard
TLS_STRATEGY=digitalocean
DO_AUTH_TOKEN=${DO_AUTH_TOKEN}
CADDY_DNS_PLUGINS=github.com/caddy-dns/digitalocean
EOF
```

### 8. Create data directories

```sh
ssh root@"$DROPLET_IP" "mkdir -p /opt/atproto-tailnet/data/headscale"
```

### 9. Configure firewall

```sh
ssh root@"$DROPLET_IP" 'bash -s' <<'REMOTE'
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable
REMOTE
```

Note: Port range 10001-10100 is not needed in coordinator mode (no per-tenant Headscale containers).

### 10. Build and start the stack

```sh
ssh root@"$DROPLET_IP" 'bash -s' <<'REMOTE'
cd /opt/atproto-tailnet
docker compose -f docker-compose.coordinator.yml build
docker compose -f docker-compose.coordinator.yml up -d
REMOTE
```

### 11. Wait for health check

Poll the health endpoint. Caddy needs time to obtain the TLS certificate on first boot.

```sh
for i in $(seq 1 60); do
  if ssh root@"$DROPLET_IP" "curl -sf http://localhost:3000/health" >/dev/null 2>&1; then
    echo "Health check passed"
    break
  fi
  sleep 5
done
```

### 12. Verify HTTPS externally

Wait for DNS propagation (up to 300s for DO DNS), then verify:

```sh
for i in $(seq 1 60); do
  if curl -sf "https://${APP_DOMAIN}/health" >/dev/null 2>&1; then
    echo "HTTPS verified"
    break
  fi
  sleep 5
done
```

## Verification

### Health check

```sh
curl -sf "https://${APP_DOMAIN}/health"
# Expected: {"status":"ok"} or similar 200 response
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

### Service logs

```sh
ssh root@"$DROPLET_IP" "cd /opt/atproto-tailnet && docker compose -f docker-compose.coordinator.yml logs --tail 50"
```

## Teardown

### 1. Stop services

```sh
ssh root@"$DROPLET_IP" "cd /opt/atproto-tailnet && docker compose -f docker-compose.coordinator.yml down -v"
```

### 2. Delete the Droplet

```sh
doctl compute droplet delete atproto-tailnet --force
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

**Cause**: DO_AUTH_TOKEN lacks domain write scope, or DNS records not yet propagated.

**Fix**:
```sh
# Check Caddy logs for ACME errors
ssh root@"$DROPLET_IP" "cd /opt/atproto-tailnet && docker compose -f docker-compose.coordinator.yml logs caddy | grep -i 'error\|acme\|tls\|challenge'"

# Verify DO_AUTH_TOKEN has write access to the domain
doctl compute domain records list "$DOMAIN"

# Verify the TLS strategy mount is correct
ssh root@"$DROPLET_IP" "docker exec \$(docker ps -qf name=caddy) ls /etc/caddy/tls-strategy/"
# Expected: global.caddy  site.caddy
```

### DNS propagation delay

**Symptom**: `dig` returns no result or old IP; curl gets connection refused.

**Cause**: DO DNS TTL not yet expired. Default TTL is 300s.

**Fix**: Wait up to 5 minutes. Verify with:
```sh
dig +short "${APP_DOMAIN}" @ns1.digitalocean.com
```

### Coordinator not starting

**Symptom**: `coordinator` container exits or health check fails.

**Fix**:
```sh
ssh root@"$DROPLET_IP" "cd /opt/atproto-tailnet && docker compose -f docker-compose.coordinator.yml logs coordinator"
# Check for: DATABASE_URL connection errors, port conflicts, build failures
```

### App returns 502 Bad Gateway

**Symptom**: Caddy is up but returns 502.

**Cause**: The `app` container is not healthy, or the coordinator is not ready.

**Fix**:
```sh
ssh root@"$DROPLET_IP" "cd /opt/atproto-tailnet && docker compose -f docker-compose.coordinator.yml ps"
# All services should show "healthy" or "Up"

# Check app logs specifically
ssh root@"$DROPLET_IP" "cd /opt/atproto-tailnet && docker compose -f docker-compose.coordinator.yml logs app"
```

### Database connection errors

**Symptom**: App or coordinator logs show `connection refused` to postgres.

**Fix**:
```sh
# Check postgres is running and healthy
ssh root@"$DROPLET_IP" "cd /opt/atproto-tailnet && docker compose -f docker-compose.coordinator.yml ps postgres"

# Verify POSTGRES_PASSWORD in .env matches DATABASE_URL
ssh root@"$DROPLET_IP" "grep POSTGRES_PASSWORD /opt/atproto-tailnet/.env"
```

### Out of memory

**Symptom**: Docker containers OOM-killed (check `dmesg` or `docker inspect`).

**Fix**: Upgrade to a larger Droplet:
```sh
doctl compute droplet-action resize atproto-tailnet --size s-2vcpu-4gb --wait
```

### Caddy build fails (DNS plugin)

**Symptom**: `docker compose build caddy` fails with xcaddy errors.

**Cause**: `CADDY_DNS_PLUGINS` env var missing or misspelled.

**Fix**: Verify `.env` contains exactly:
```
CADDY_DNS_PLUGINS=github.com/caddy-dns/digitalocean
```
