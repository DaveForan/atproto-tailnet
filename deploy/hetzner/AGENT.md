# Deploying atproto-tailnet on Hetzner Cloud

Machine-readable deployment guide for AI agents.

## Overview

- A single Hetzner Cloud server (cx22 or cx32) in coordinator mode
- TLS strategy: `hetzner` (DNS-01 wildcard with the Hetzner DNS API)
- Compose file: `docker-compose.coordinator.yml`
- No Docker socket mount needed (the coordinator replaces the Headscale container of each tenant)
- Cost: ~EUR 4-8/month (cx22 = EUR 3.98, cx32 = EUR 7.11)

## Prerequisites

| Prerequisite | Check command |
|---|---|
| Hetzner Cloud account with API token | `hcloud context list` |
| `hcloud` CLI installed and authenticated | `hcloud version` |
| Domain added to Hetzner DNS Console (dns.hetzner.com) | See DNS API section |
| SSH key uploaded to Hetzner Cloud | `hcloud ssh-key list` |
| Hetzner DNS API token (separate from Cloud API token) | Generated at dns.hetzner.com |

**Important**: Hetzner has two separate APIs with separate tokens:
1. **Cloud API** (`api.hetzner.cloud`) -- the `hcloud` CLI uses this API. It controls servers and firewalls.
2. **DNS API** (`dns.hetzner.com/api/v1`) -- it has no CLI support. It controls DNS records. Generate the token at https://dns.hetzner.com/settings/api-token

You need both tokens. Pass the DNS API token to Caddy as `HETZNER_API_TOKEN` for ACME DNS-01 challenges.

## Required Inputs

| Variable | Description | Example |
|---|---|---|
| `HETZNER_API_TOKEN` | Hetzner DNS API token (for Caddy DNS-01 challenges) | `abcdef1234567890` |
| `HCLOUD_TOKEN` | Hetzner Cloud API token (for `hcloud` CLI) | Set via `hcloud context create` |
| `DOMAIN` | Base domain for the deployment | `example.com` |
| `APP_SUBDOMAIN` | Subdomain for the app UI | `tailnets` (gives `tailnets.example.com`) |
| `TS_SUBDOMAIN` | Subdomain for tenant tailnets | `ts` (gives `*.ts.example.com`) |
| `SSH_KEY_NAME` | Name of SSH key in Hetzner Cloud | Output of `hcloud ssh-key list` |
| `SERVER_TYPE` | Hetzner server type (lowercase) | `cx22` (2 vCPU, 4 GB) or `cx32` (4 vCPU, 8 GB) |
| `LOCATION` | Hetzner datacenter | `fsn1` (Falkenstein), `nbg1` (Nuremberg), `hel1` (Helsinki) |
| `REPO_URL` | Git repository URL | `https://github.com/your-org/atproto-tailnet.git` |
| `BRANCH` | Git branch to deploy | `main` |
| `OPERATOR_DIDS` | Comma-separated DIDs of the instance operators. You must set it before the first sign-in | `did:plc:abc123...` |
| `ADMIN_IP` | Public IP address that can connect with SSH | `203.0.113.10` |

To find the DID of a Bluesky account, use this command:

```sh
curl "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=you.bsky.social"
```

Only operators, and the "tailnet creators" that an operator designates, get a tailnet. All other users who sign in see a "no access" view. This view shows their pending invitations and a "Request to join" button for the default tailnet. The first tailnet that an operator creates becomes the default tailnet. If `OPERATOR_DIDS` is empty, the app logs a loud warning and nobody can create a tailnet.

### Secrets to Generate

```sh
SESSION_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 16)
COORDINATOR_API_KEY=$(openssl rand -hex 32)
FEDERATION_KEY_ENCRYPTION_KEY=$(openssl rand -hex 32)
```

The app does not start in production if `SESSION_SECRET` or `COORDINATOR_API_KEY` has fewer than 32 characters. It also does not start if the value contains `change-me` or `changeme`. The coordinator applies the same rule to its admin key.

You also need `ATPROTO_PRIVATE_KEY`. Generate it on the server in step 6.

## Deployment Steps

### Step 1: Create Firewall

Docker-published ports (80, 443) bypass `ufw`. `ufw` alone does not protect them. Use the Hetzner Cloud firewall. Allow SSH from your IP only.

```sh
hcloud firewall create --name atproto-tailnet-fw
hcloud firewall add-rule atproto-tailnet-fw --direction in --protocol tcp --port 22 --source-ips "${ADMIN_IP}/32" --description "SSH"
hcloud firewall add-rule atproto-tailnet-fw --direction in --protocol tcp --port 80 --source-ips 0.0.0.0/0 --source-ips ::/0 --description "HTTP"
hcloud firewall add-rule atproto-tailnet-fw --direction in --protocol tcp --port 443 --source-ips 0.0.0.0/0 --source-ips ::/0 --description "HTTPS"
hcloud firewall add-rule atproto-tailnet-fw --direction in --protocol udp --port 443 --source-ips 0.0.0.0/0 --source-ips ::/0 --description "HTTP3"
```

### Step 2: Create Server

```sh
hcloud server create \
  --name atproto-tailnet \
  --type cx22 \
  --image ubuntu-22.04 \
  --ssh-key <SSH_KEY_NAME> \
  --location fsn1 \
  --firewall atproto-tailnet-fw
```

### Step 3: Obtain Server IP

```sh
SERVER_IP=$(hcloud server ip atproto-tailnet)
echo "$SERVER_IP"
```

### Step 4: Create DNS Records via Hetzner DNS API

The `hcloud` CLI does not manage DNS. Use the DNS API directly.

#### 4a. Obtain Zone ID

```sh
HETZNER_DNS_TOKEN="<your-dns-api-token>"

curl -s \
  -H "Auth-API-Token: ${HETZNER_DNS_TOKEN}" \
  "https://dns.hetzner.com/api/v1/zones" | jq -r '.zones[] | "\(.id) \(.name)"'
```

Find your domain in the output. Save the zone ID:

```sh
ZONE_ID="<zone-id-from-output>"
```

Or filter the output directly:

```sh
ZONE_ID=$(curl -s \
  -H "Auth-API-Token: ${HETZNER_DNS_TOKEN}" \
  "https://dns.hetzner.com/api/v1/zones?name=example.com" \
  | jq -r '.zones[0].id')
```

#### 4b. Create A Record for App Domain

```sh
curl -s -X POST \
  -H "Auth-API-Token: ${HETZNER_DNS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"zone_id\": \"${ZONE_ID}\",
    \"type\": \"A\",
    \"name\": \"tailnets\",
    \"value\": \"${SERVER_IP}\",
    \"ttl\": 300
  }" \
  "https://dns.hetzner.com/api/v1/records"
```

#### 4c. Create Wildcard A Record for Tenant Subdomains

```sh
curl -s -X POST \
  -H "Auth-API-Token: ${HETZNER_DNS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"zone_id\": \"${ZONE_ID}\",
    \"type\": \"A\",
    \"name\": \"*.ts\",
    \"value\": \"${SERVER_IP}\",
    \"ttl\": 300
  }" \
  "https://dns.hetzner.com/api/v1/records"
```

#### 4d. Verify DNS Records

```sh
curl -s \
  -H "Auth-API-Token: ${HETZNER_DNS_TOKEN}" \
  "https://dns.hetzner.com/api/v1/records?zone_id=${ZONE_ID}" \
  | jq '.records[] | select(.name == "tailnets" or .name == "*.ts") | {name, type, value}'
```

Wait for propagation:

```sh
dig +short tailnets.example.com
# Expected: <SERVER_IP>
```

### Step 5: Run Server Setup Script

The script installs Docker and clones the repository. It copies `.env.coordinator.example` to `.env` and generates the secrets. Then it exits, so that you can edit `.env`.

```sh
ssh root@${SERVER_IP} 'bash -s' < deploy/hetzner/server-setup.sh
```

Or use a custom repository and branch:

```sh
ssh root@${SERVER_IP} "REPO_URL=https://github.com/your-org/atproto-tailnet.git BRANCH=main bash -s" < deploy/hetzner/server-setup.sh
```

### Step 6: Configure Environment

```sh
ssh root@${SERVER_IP}
cd /opt/atproto-tailnet
```

Edit `.env`:

```sh
cat > .env << 'ENVEOF'
# Database
POSTGRES_USER=atproto_tailnet
POSTGRES_PASSWORD=<GENERATED>
POSTGRES_DB=atproto_tailnet
DATABASE_URL=postgresql://atproto_tailnet:<GENERATED>@postgres:5432/atproto_tailnet

# App
SESSION_SECRET=<GENERATED>
PORT=3000
PUBLIC_URL=https://tailnets.example.com
BASE_DOMAIN=ts.example.com
APP_DOMAIN=tailnets.example.com
LOG_LEVEL=info

# Coordinator (COORD_LISTEN and COORD_ADMIN_KEY are set by docker-compose.coordinator.yml)
COORDINATOR_URL=http://coordinator:9443
COORDINATOR_API_KEY=<GENERATED>

# Collective signing keys and credentials (federation stays off; do not set FEDERATION_ENABLED)
FEDERATION_KEY_ENCRYPTION_KEY=<GENERATED>

# Instance operators (must be set before the first sign-in)
OPERATOR_DIDS=did:plc:<YOUR-DID>

# TLS (Hetzner DNS-01)
TLS_STRATEGY=hetzner
CADDY_DNS_PLUGINS=github.com/caddy-dns/hetzner
HETZNER_API_TOKEN=<DNS-API-TOKEN>
ENVEOF
```

Replace each `<GENERATED>`, `<DNS-API-TOKEN>`, and `<YOUR-DID>` placeholder with the actual value. The setup script already generated secrets in the old `.env`. You can copy them from there before you overwrite the file.

Restrict the file permissions:

```sh
chmod 600 /opt/atproto-tailnet/.env
```

Federation is off by default. Its data plane needs Docker (Headscale mode), and the coordinator stack does not send traffic between instances.

Generate `ATPROTO_PRIVATE_KEY` on the server, after `.env` exists. Production sign-in fails without it. The command uses the `jose` dependency in the app image:

```sh
cd /opt/atproto-tailnet
KEY=$(docker compose -f docker-compose.coordinator.yml run --rm --no-deps --entrypoint node app \
  --input-type=module -e "import {generateKeyPair,exportJWK} from 'jose'; const {privateKey}=await generateKeyPair('ES256',{extractable:true}); console.log(JSON.stringify({...await exportJWK(privateKey),alg:'ES256'}))")
echo "ATPROTO_PRIVATE_KEY='${KEY}'" >> .env
```

The value is a one-line ES256 (P-256) private JWK in single quotes: `ATPROTO_PRIVATE_KEY='{"kty":"EC",...}'`. A PKCS8 PEM also works, but it has many lines, so use the JWK.

### Step 7: Start Services

```sh
ssh root@${SERVER_IP} "cd /opt/atproto-tailnet && docker compose -f docker-compose.coordinator.yml up -d"
```

### Step 8: Verify Deployment

```sh
# Health check
curl -f https://tailnets.example.com/health

# Check all containers are running
ssh root@${SERVER_IP} "cd /opt/atproto-tailnet && docker compose -f docker-compose.coordinator.yml ps"

# Check logs for errors
ssh root@${SERVER_IP} "cd /opt/atproto-tailnet && docker compose -f docker-compose.coordinator.yml logs --tail=50"

# Verify TLS certificate (should be Let's Encrypt, not self-signed)
echo | openssl s_client -connect tailnets.example.com:443 -servername tailnets.example.com 2>/dev/null | openssl x509 -noout -issuer -subject -dates
```

### Step 9: Sign In as the Operator

The operator must sign in first after the deploy. Open `https://tailnets.example.com` and sign in with the Bluesky account in `OPERATOR_DIDS`. Then create the first tailnet. This tailnet becomes the default tailnet and accepts join requests. A sign-in does not create a tailnet automatically.

To connect Claude, add a custom connector with the URL `https://tailnets.example.com/mcp`. The connector uses OAuth sign-in with Bluesky. See [docs/site/guides/mcp.md](../../docs/site/guides/mcp.md).

Caddy sets HSTS on `APP_DOMAIN`. Tenant subdomains (`<slug>.BASE_DOMAIN`) expose only `/key`, `/ts2021`, and `/health` from the coordinator. The compose file does not publish the coordinator port (9443) or Postgres.

## DNS API Reference

All Hetzner DNS API endpoints use `https://dns.hetzner.com/api/v1` as the base URL.
For authentication, send the `Auth-API-Token` header with the DNS API token.

| Operation | Method | Endpoint | Body |
|---|---|---|---|
| List zones | GET | `/zones` | -- |
| Get zone by name | GET | `/zones?name=example.com` | -- |
| List records | GET | `/records?zone_id={id}` | -- |
| Create record | POST | `/records` | `{"zone_id","type","name","value","ttl"}` |
| Update record | PUT | `/records/{id}` | `{"zone_id","type","name","value","ttl"}` |
| Delete record | DELETE | `/records/{id}` | -- |

## Verification Checklist

```
[ ] hcloud server list shows atproto-tailnet as running
[ ] dig tailnets.example.com returns SERVER_IP
[ ] dig anything.ts.example.com returns SERVER_IP
[ ] curl https://tailnets.example.com/health returns 200
[ ] TLS certificate is issued by Let's Encrypt (not self-signed)
[ ] docker compose ps shows all 4 services healthy (coordinator, app, postgres, caddy)
[ ] docker compose logs caddy shows successful ACME certificate issuance
[ ] docker compose logs coordinator shows "listening" with listen_addr=0.0.0.0:9443
[ ] docker compose logs app does not show "OPERATOR_DIDS IS EMPTY"
[ ] The operator can sign in and create the first tailnet
```

## Teardown

```sh
# Stop services (-v deletes all volumes, including pgdata and coord_data)
ssh root@${SERVER_IP} "cd /opt/atproto-tailnet && docker compose -f docker-compose.coordinator.yml down -v"

# Delete server
hcloud server delete atproto-tailnet

# Delete firewall
hcloud firewall delete atproto-tailnet-fw

# Delete DNS records (get record IDs first)
RECORD_IDS=$(curl -s \
  -H "Auth-API-Token: ${HETZNER_DNS_TOKEN}" \
  "https://dns.hetzner.com/api/v1/records?zone_id=${ZONE_ID}" \
  | jq -r '.records[] | select(.name == "tailnets" or .name == "*.ts") | .id')

for id in $RECORD_IDS; do
  curl -s -X DELETE \
    -H "Auth-API-Token: ${HETZNER_DNS_TOKEN}" \
    "https://dns.hetzner.com/api/v1/records/${id}"
done
```

## Troubleshooting

### Server does not start

```sh
hcloud server describe atproto-tailnet
hcloud server reset atproto-tailnet   # hard reboot
```

### Caddy fails to obtain TLS certificate

Make sure that `HETZNER_API_TOKEN` is the **DNS API** token (from dns.hetzner.com). It must not be the Cloud API token.

```sh
# Test DNS API token
curl -s -H "Auth-API-Token: ${HETZNER_DNS_TOKEN}" "https://dns.hetzner.com/api/v1/zones"

# Check Caddy logs for ACME errors
ssh root@${SERVER_IP} "cd /opt/atproto-tailnet && docker compose -f docker-compose.coordinator.yml logs caddy | grep -i acme"
```

### Containers crash repeatedly

```sh
ssh root@${SERVER_IP} "cd /opt/atproto-tailnet && docker compose -f docker-compose.coordinator.yml logs --tail=100 <service>"
```

Replace `<service>` with one of these names:
- `coordinator`
- `app`
- `postgres`
- `caddy`

### Database connection refused

Postgres must be healthy before the coordinator and the app start. Check Postgres:

```sh
ssh root@${SERVER_IP} "cd /opt/atproto-tailnet && docker compose -f docker-compose.coordinator.yml logs postgres"
ssh root@${SERVER_IP} "cd /opt/atproto-tailnet && docker compose -f docker-compose.coordinator.yml exec postgres pg_isready -U atproto_tailnet"
```

### DNS not resolving

Hetzner DNS propagation usually takes 1-5 minutes. Check the records:

```sh
dig +short tailnets.example.com @oxygen.ns.hetzner.com
dig +short tailnets.example.com @hydrogen.ns.hetzner.com
```

If the records exist in the API but do not resolve, verify that the NS records of the domain point to Hetzner (`oxygen.ns.hetzner.com`, `hydrogen.ns.hetzner.com`, `helium.ns.hetzner.de`).

### Disk space

The CX22 has 40 GB. Check the disk usage:

```sh
ssh root@${SERVER_IP} "df -h / && docker system df"
```

Prune unused images:

```sh
ssh root@${SERVER_IP} "docker system prune -af"
```

## Backups

### Database Backup

```sh
# Manual backup
ssh root@${SERVER_IP} "cd /opt/atproto-tailnet && docker compose -f docker-compose.coordinator.yml exec -T postgres pg_dump -U atproto_tailnet atproto_tailnet | gzip > /opt/backups/db-\$(date +%Y%m%d).sql.gz"

# Crontab entry (add via: ssh root@... crontab -e)
0 3 * * * cd /opt/atproto-tailnet && docker compose -f docker-compose.coordinator.yml exec -T postgres pg_dump -U atproto_tailnet atproto_tailnet | gzip > /opt/backups/db-$(date +\%Y\%m\%d).sql.gz
```

### Volumes

Back up the `pgdata` and `coord_data` volumes. `coord_data` holds the coordinator Noise control key (`COORD_CONTROL_KEY_PATH=/var/lib/coordinator/control.key`). If you lose it, all devices must register and connect again. A server snapshot includes both volumes.

### Server Snapshot

```sh
hcloud server create-image --type snapshot --description "atproto-tailnet $(date +%Y-%m-%d)" atproto-tailnet
```

## Cost Estimate

| Resource | Monthly Cost |
|---|---|
| CX22 (2 vCPU, 4 GB RAM, 40 GB SSD) | EUR 3.98 |
| CX32 (4 vCPU, 8 GB RAM, 80 GB SSD) | EUR 7.11 |
| Snapshots | EUR 0.01/GB/month |
| Traffic | 20 TB included |
| **Total (CX22)** | **~EUR 4/month** |
| **Total (CX32)** | **~EUR 7/month** |
