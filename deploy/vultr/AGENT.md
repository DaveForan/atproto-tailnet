# Vultr Deployment — Agent Instructions

## Overview

Single Vultr Cloud Compute instance running atproto-tailnet in **coordinator mode**.

- **Instance plan**: `vc2-1c-2gb` (1 vCPU, 2 GB RAM, $6/mo) or `vc2-2c-4gb` (2 vCPU, 4 GB RAM, $24/mo)
- **TLS strategy**: `vultr` — DNS-01 wildcard certificates via Vultr DNS API
- **Caddy DNS plugin**: `github.com/caddy-dns/vultr`
- **Compose file**: `docker-compose.coordinator.yml`
- **Cost**: ~$6-24/month (compute only; Vultr DNS is free)

## Prerequisites

- Vultr account with API key enabled at <https://my.vultr.com/settings/#settingsapi>
- `vultr-cli` installed and authenticated (`VULTR_API_KEY` env var)
- Domain added to Vultr DNS (`vultr-cli dns domain list` to verify)
- SSH key uploaded to Vultr (`vultr-cli ssh-key list` to verify)

## Required Inputs

| Input | Description | Example |
|---|---|---|
| `VULTR_API_KEY` | Vultr API key (Personal Access Token) | `ABCDEF123456...` |
| `domain` | Base domain you control | `yourdomain.com` |
| `ssh_key_id` | SSH key ID from `vultr-cli ssh-key list` | `a1b2c3d4-...` |
| `plan` | Instance plan slug | `vc2-1c-2gb` |
| `region` | Vultr region slug | `ewr` (New Jersey), `ord` (Chicago), `lax` (Los Angeles) |
| `REPO_URL` | Git clone URL | `https://github.com/your-org/atproto-tailnet.git` |
| `BRANCH` | Git branch | `main` |

### Secrets to Generate

Generate these before deployment. Do not reuse values.

```sh
SESSION_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
COORDINATOR_API_KEY=$(openssl rand -hex 32)
FEDERATION_KEY_ENCRYPTION_KEY=$(openssl rand -hex 32)
```

## Deployment Steps

### 1. Create the instance

```sh
vultr-cli instance create \
  --plan vc2-1c-2gb \
  --region ewr \
  --os 2284 \
  --ssh-keys <ssh_key_id> \
  --label atproto-tailnet
```

OS `2284` = Ubuntu 24.04 LTS x64. Use `387` for Ubuntu 22.04 x64.

To list available OS IDs: `vultr-cli os list | grep -i ubuntu`

### 2. Wait for instance and get IP

```sh
vultr-cli instance list
```

Wait until `STATUS` shows `active` and `POWER STATUS` shows `running`. Note the `MAIN IP` value.

To poll:

```sh
vultr-cli instance get <instance-id>
```

### 3. Create DNS records

If the domain is not yet on Vultr DNS:

```sh
vultr-cli dns domain create --domain yourdomain.com --ip <ip>
```

Create the A record for the app:

```sh
vultr-cli dns record create \
  --domain yourdomain.com \
  --type A \
  --name tailnets \
  --data <ip> \
  --ttl 300
```

Create the wildcard A record for tenant subdomains:

```sh
vultr-cli dns record create \
  --domain yourdomain.com \
  --type A \
  --name '*.ts' \
  --data <ip> \
  --ttl 300
```

Verify:

```sh
vultr-cli dns record list --domain yourdomain.com
```

### 4. SSH in and run the bootstrap script

```sh
ssh root@<ip> 'bash -s' < deploy/vultr/server-setup.sh
```

Or with explicit repo/branch:

```sh
ssh root@<ip> 'REPO_URL=https://github.com/your-org/atproto-tailnet.git BRANCH=main bash -s' < deploy/vultr/server-setup.sh
```

### 5. Configure environment

SSH into the instance and edit `.env`:

```sh
ssh root@<ip>
cd /opt/atproto-tailnet
nano .env
```

Set the following values:

| Variable | Value |
|---|---|
| `SESSION_SECRET` | (generated above) |
| `POSTGRES_PASSWORD` | (generated above) |
| `DATABASE_URL` | `postgresql://atproto_tailnet:<POSTGRES_PASSWORD>@postgres:5432/atproto_tailnet` |
| `PUBLIC_URL` | `https://tailnets.yourdomain.com` |
| `BASE_DOMAIN` | `ts.yourdomain.com` |
| `APP_DOMAIN` | `tailnets.yourdomain.com` |
| `COORDINATOR_API_KEY` | (generated above) |
| `FEDERATION_KEY_ENCRYPTION_KEY` | (generated above) |
| `TLS_STRATEGY` | `vultr` |
| `CADDY_DNS_PLUGINS` | `github.com/caddy-dns/vultr` |
| `VULTR_API_KEY` | (your Vultr API key) |

### 6. Start the stack

```sh
cd /opt/atproto-tailnet
docker compose -f docker-compose.coordinator.yml up -d
```

### 7. Configure firewall

```sh
ufw allow 22/tcp           # SSH
ufw allow 80/tcp           # HTTP (Caddy redirect)
ufw allow 443/tcp          # HTTPS
ufw allow 443/udp          # HTTP/3 / QUIC
ufw allow 10001:10100/tcp  # Headscale tenant ports
ufw --force enable
```

Or use Vultr's firewall groups:

```sh
vultr-cli firewall group create --description atproto-tailnet
# Note the FIREWALLGROUPID from output
vultr-cli firewall rule create \
  --id <firewall-group-id> --protocol tcp --subnet 0.0.0.0 --size 0 --port 22
vultr-cli firewall rule create \
  --id <firewall-group-id> --protocol tcp --subnet 0.0.0.0 --size 0 --port 80
vultr-cli firewall rule create \
  --id <firewall-group-id> --protocol tcp --subnet 0.0.0.0 --size 0 --port 443
vultr-cli firewall rule create \
  --id <firewall-group-id> --protocol udp --subnet 0.0.0.0 --size 0 --port 443
vultr-cli firewall rule create \
  --id <firewall-group-id> --protocol tcp --subnet 0.0.0.0 --size 0 --port "10001:10100"
```

## Verification

### Health check

```sh
curl -sf https://tailnets.yourdomain.com/health
```

Expected: `{"status":"ok"}`

### DNS resolution

```sh
dig +short tailnets.yourdomain.com
dig +short test.ts.yourdomain.com
```

Both should return the instance IP.

### TLS certificate

```sh
curl -vI https://tailnets.yourdomain.com 2>&1 | grep -E 'issuer|subject'
```

Should show a Let's Encrypt certificate for `tailnets.yourdomain.com`.

### Container status

```sh
ssh root@<ip> 'cd /opt/atproto-tailnet && docker compose -f docker-compose.coordinator.yml ps'
```

All services (coordinator, app, postgres, caddy) should show `Up`.

### Logs

```sh
ssh root@<ip> 'cd /opt/atproto-tailnet && docker compose -f docker-compose.coordinator.yml logs -f'
```

## Monitoring

```sh
# All logs
docker compose -f docker-compose.coordinator.yml logs -f

# Single service
docker compose -f docker-compose.coordinator.yml logs -f app
docker compose -f docker-compose.coordinator.yml logs -f coordinator
docker compose -f docker-compose.coordinator.yml logs -f caddy

# Resource usage
docker stats
```

## Backups

Enable Vultr automatic backups on the instance ($1.20/mo for vc2-1c-2gb):

```sh
vultr-cli instance update <instance-id> --backups enable
```

Set up periodic Postgres dumps:

```sh
# Add to root crontab: crontab -e
0 3 * * * docker compose -f /opt/atproto-tailnet/docker-compose.coordinator.yml \
  exec -T postgres pg_dump -U atproto_tailnet atproto_tailnet | \
  gzip > /opt/backups/db-$(date +\%Y\%m\%d).sql.gz
```

Create the backup directory:

```sh
mkdir -p /opt/backups
```

## Teardown

### Delete the instance

```sh
vultr-cli instance delete <instance-id>
```

### Remove DNS records

```sh
vultr-cli dns record list --domain yourdomain.com
# Note the RECORDID values for tailnets and *.ts records
vultr-cli dns record delete --domain yourdomain.com --record-id <record-id>
```

### Remove firewall group (if created)

```sh
vultr-cli firewall group delete --id <firewall-group-id>
```

## Troubleshooting

### Instance won't start

```sh
vultr-cli instance get <instance-id>
```

Check `STATUS` and `POWER STATUS`. If stuck in `pending`, wait — Vultr provisioning can take 1-5 minutes.

### DNS not resolving

Vultr DNS propagation can take up to 15 minutes. Verify the records exist:

```sh
vultr-cli dns record list --domain yourdomain.com
```

Confirm name servers are set to Vultr (`ns1.vultr.com`, `ns2.vultr.com`) at your registrar.

### TLS certificate not issued

Check Caddy logs for ACME errors:

```sh
docker compose -f docker-compose.coordinator.yml logs caddy | grep -i "acme\|tls\|certificate\|error"
```

Common causes:
- `VULTR_API_KEY` not set or invalid in `.env`
- `TLS_STRATEGY` not set to `vultr`
- `CADDY_DNS_PLUGINS` not set to `github.com/caddy-dns/vultr`
- Domain not using Vultr name servers (DNS-01 requires Vultr to serve the `_acme-challenge` TXT record)

### Coordinator not healthy

```sh
docker compose -f docker-compose.coordinator.yml logs coordinator
```

Check that `COORDINATOR_API_KEY` matches between app and coordinator, and that Postgres is healthy:

```sh
docker compose -f docker-compose.coordinator.yml exec postgres pg_isready -U atproto_tailnet
```

### SSH connection refused

Vultr instances use password auth by default if SSH key was not attached at creation. Re-create the instance with `--ssh-keys` or use the Vultr console (web dashboard) to access the instance.

### Out of memory (vc2-1c-2gb)

If the 2 GB plan runs out of memory during Docker builds:

```sh
# Add swap
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

Then retry:

```sh
docker compose -f docker-compose.coordinator.yml up -d
```

If the problem persists, upgrade to `vc2-2c-4gb`:

```sh
vultr-cli instance update <instance-id> --plan vc2-2c-4gb
```
