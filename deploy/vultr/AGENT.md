# Vultr Deployment — Agent Instructions

## Overview

A single Vultr Cloud Compute instance runs atproto-tailnet in **coordinator mode**.

- **Instance plan**: `vc2-1c-2gb` (1 vCPU, 2 GB RAM, $6/mo) or `vc2-2c-4gb` (2 vCPU, 4 GB RAM, $24/mo)
- **TLS strategy**: `vultr` — DNS-01 wildcard certificates with the Vultr DNS API
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
| `APP_SUBDOMAIN` | Subdomain for the web UI | `tailnets` |
| `TS_SUBDOMAIN` | Subdomain prefix for the tenant wildcard | `ts` |
| `OPERATOR_DIDS` | Comma-separated DIDs of the instance operators. You must set it before the first sign-in | `did:plc:abc123...` |
| `ADMIN_IP` | Public IP address that can connect with SSH | `203.0.113.10` |

To find the DID of a Bluesky account, use this command:

```sh
curl "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=you.bsky.social"
```

Only operators, and the "tailnet creators" that an operator designates, get a tailnet. All other users who sign in see a "no access" view. This view shows their pending invitations and a "Request to join" button for the default tailnet. The first tailnet that an operator creates becomes the default tailnet. If `OPERATOR_DIDS` is empty, the app logs a loud warning and nobody can create a tailnet.

### Secrets to Generate

The bootstrap script (step 5) generates these secrets in `.env`. To make them yourself, use these commands. Do not reuse values.

```sh
SESSION_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
COORDINATOR_API_KEY=$(openssl rand -hex 32)
FEDERATION_KEY_ENCRYPTION_KEY=$(openssl rand -hex 32)
```

The app does not start in production if `SESSION_SECRET` or `COORDINATOR_API_KEY` has fewer than 32 characters. It also does not start if the value contains `change-me` or `changeme`. The coordinator applies the same rule to its admin key.

## Deployment Steps

### 1. Create the firewall group

Docker-published ports (80, 443) bypass `ufw`. The bootstrap script enables `ufw` on its second run, but `ufw` alone does not protect these ports. Use a Vultr firewall group:

```sh
vultr-cli firewall group create --description atproto-tailnet
# Note the firewall group ID
vultr-cli firewall rule create --id <firewall-group-id> --protocol tcp --port 22 --subnet "$ADMIN_IP" --size 32 --ip-type v4
vultr-cli firewall rule create --id <firewall-group-id> --protocol tcp --port 80 --subnet 0.0.0.0 --size 0 --ip-type v4
vultr-cli firewall rule create --id <firewall-group-id> --protocol tcp --port 443 --subnet 0.0.0.0 --size 0 --ip-type v4
vultr-cli firewall rule create --id <firewall-group-id> --protocol udp --port 443 --subnet 0.0.0.0 --size 0 --ip-type v4
```

Add the same rules with `--ip-type v6 --subnet :: --size 0` if the instance has IPv6. Do not open the coordinator port (9443) or Postgres. The compose file does not publish them.

### 2. Create the instance

```sh
vultr-cli instance create \
  --plan vc2-1c-2gb \
  --region ewr \
  --os 2284 \
  --ssh-keys <ssh_key_id> \
  --firewall-group <firewall-group-id> \
  --label atproto-tailnet
```

You can also attach the firewall group to the instance in the Vultr web console.

OS `2284` = Ubuntu 24.04 LTS x64. Use `387` for Ubuntu 22.04 x64.

To list the available OS IDs: `vultr-cli os list | grep -i ubuntu`

### 3. Wait for the instance and obtain the IP

```sh
vultr-cli instance list
```

Wait until `STATUS` shows `active` and `POWER STATUS` shows `running`. Note the `MAIN IP` value.

To poll the instance:

```sh
vultr-cli instance get <instance-id>
```

### 4. Create DNS records

If the domain is not on Vultr DNS yet, add it:

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

### 5. SSH in and run the bootstrap script

```sh
ssh root@<ip> 'bash -s' < deploy/vultr/server-setup.sh
```

Or set the repository and branch explicitly:

```sh
ssh root@<ip> 'REPO_URL=https://github.com/your-org/atproto-tailnet.git BRANCH=main bash -s' < deploy/vultr/server-setup.sh
```

### 6. Configure environment

On the first run, the bootstrap script generates the secrets, sets `TLS_STRATEGY=vultr`, and exits. Set the remaining values over SSH:

```sh
ssh root@<ip> bash -c "
cd /opt/atproto-tailnet
sed -i 's|^PUBLIC_URL=.*|PUBLIC_URL=https://${APP_SUBDOMAIN}.${domain}|' .env
sed -i 's|^BASE_DOMAIN=.*|BASE_DOMAIN=${TS_SUBDOMAIN}.${domain}|' .env
sed -i 's|^# APP_DOMAIN=.*|APP_DOMAIN=${APP_SUBDOMAIN}.${domain}|' .env
sed -i 's|^VULTR_API_KEY=.*|VULTR_API_KEY=${VULTR_API_KEY}|' .env
sed -i 's|^# OPERATOR_DIDS=.*|OPERATOR_DIDS=${OPERATOR_DIDS}|' .env
chmod 600 .env
"
```

Do not set `FEDERATION_ENABLED`. Federation is off by default. Its data plane needs Docker (Headscale mode), and the coordinator stack does not send traffic between instances. The app still uses `FEDERATION_KEY_ENCRYPTION_KEY` for collective signing keys and credentials.

### 7. Generate the AT Protocol OAuth key

Production sign-in fails without `ATPROTO_PRIVATE_KEY`. Use a one-line ES256 (P-256) private JWK. A PKCS8 PEM also works, but it has many lines, so use the JWK. Run this on the instance after `.env` exists. It uses the `jose` dependency in the app image:

```sh
cd /opt/atproto-tailnet
KEY=$(docker compose -f docker-compose.coordinator.yml run --rm --no-deps --entrypoint node app \
  --input-type=module -e "import {generateKeyPair,exportJWK} from 'jose'; const {privateKey}=await generateKeyPair('ES256',{extractable:true}); console.log(JSON.stringify({...await exportJWK(privateKey),alg:'ES256'}))")
echo "ATPROTO_PRIVATE_KEY='${KEY}'" >> .env
```

The result is one line in single quotes: `ATPROTO_PRIVATE_KEY='{"kty":"EC",...}'`.

### 8. Start the stack

Run the bootstrap script again. When `.env` exists, the script does these steps:

- It creates the backup directory `/opt/backups`.
- It adds 2 GB of swap.
- It builds the images and starts the stack.
- It enables `ufw`.

```sh
ssh root@<ip> 'bash -s' < deploy/vultr/server-setup.sh
```

To start only the stack, run these commands on the instance:

```sh
cd /opt/atproto-tailnet
docker compose -f docker-compose.coordinator.yml up -d
```

### 9. Wait for HTTPS readiness

DNS propagation and TLS certificate issuance take time. Poll until the service responds over HTTPS:

```sh
for i in $(seq 1 90); do
  if curl -sf "https://${APP_SUBDOMAIN}.${domain}/health" > /dev/null 2>&1; then
    echo "HTTPS verified"
    break
  fi
  echo "Waiting for HTTPS... ($i/90)"
  sleep 10
done
```

### 10. Sign in as the operator

The operator must sign in first after the deploy. Open `https://tailnets.yourdomain.com` and sign in with the Bluesky account in `OPERATOR_DIDS`. Then create the first tailnet. This tailnet becomes the default tailnet and accepts join requests. A sign-in does not create a tailnet automatically.

To connect Claude, add a custom connector with the URL `https://tailnets.yourdomain.com/mcp`. The connector uses OAuth sign-in with Bluesky. See [docs/site/guides/mcp.md](../../docs/site/guides/mcp.md).

## Verification

### Health check

```sh
curl -f https://tailnets.yourdomain.com/health
```

Expected: `{"status":"ok"}`

Caddy sets HSTS on `APP_DOMAIN`. Tenant subdomains (`<slug>.BASE_DOMAIN`) expose only `/key`, `/ts2021`, and `/health` from the coordinator.

### DNS resolution

```sh
dig +short tailnets.yourdomain.com
dig +short test.ts.yourdomain.com
```

Both commands must return the instance IP.

### TLS certificate

```sh
curl -vI https://tailnets.yourdomain.com 2>&1 | grep -E 'issuer|subject'
```

The output must show a Let's Encrypt certificate for `tailnets.yourdomain.com`.

### Container status

```sh
ssh root@<ip> 'cd /opt/atproto-tailnet && docker compose -f docker-compose.coordinator.yml ps'
```

All services (coordinator, app, postgres, caddy) must show `Up`.

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

Enable automatic Vultr backups on the instance ($1.20/mo for vc2-1c-2gb):

```sh
vultr-cli instance update <instance-id> --backups enable
```

Back up the `pgdata` and `coord_data` Docker volumes. `coord_data` holds the coordinator Noise control key (`COORD_CONTROL_KEY_PATH=/var/lib/coordinator/control.key`). If you lose it, all devices must register and connect again. Vultr instance backups include both volumes.

Set up regular Postgres dumps:

```sh
# Add to root crontab: crontab -e
0 3 * * * docker compose -f /opt/atproto-tailnet/docker-compose.coordinator.yml \
  exec -T postgres pg_dump -U atproto_tailnet atproto_tailnet | \
  gzip > /opt/backups/db-$(date +\%Y\%m\%d).sql.gz
```

The second run of the bootstrap script creates the backup directory `/opt/backups`. If you did not run it again, create the directory:

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

### Remove the firewall group

```sh
vultr-cli firewall group delete --id <firewall-group-id>
```

## Troubleshooting

### Instance does not start

```sh
vultr-cli instance get <instance-id>
```

Check `STATUS` and `POWER STATUS`. If the status stays `pending`, wait. Vultr provisioning can take 1-5 minutes.

### DNS not resolving

Vultr DNS propagation can take up to 15 minutes. Verify that the records exist:

```sh
vultr-cli dns record list --domain yourdomain.com
```

Confirm that the name servers at your registrar are Vultr name servers (`ns1.vultr.com`, `ns2.vultr.com`).

### TLS certificate not issued

Check Caddy logs for ACME errors:

```sh
docker compose -f docker-compose.coordinator.yml logs caddy | grep -i "acme\|tls\|certificate\|error"
```

Common causes:
- `VULTR_API_KEY` is not set or is not valid in `.env`
- `TLS_STRATEGY` is not set to `vultr`
- `CADDY_DNS_PLUGINS` is not set to `github.com/caddy-dns/vultr`
- The domain does not use Vultr name servers (DNS-01 requires Vultr to serve the `_acme-challenge` TXT record)

### Coordinator not healthy

```sh
docker compose -f docker-compose.coordinator.yml logs coordinator
```

Make sure that `COORDINATOR_API_KEY` is the same in the app and the coordinator. Make sure that Postgres is healthy:

```sh
docker compose -f docker-compose.coordinator.yml exec postgres pg_isready -U atproto_tailnet
```

### SSH connection refused

Vultr instances use password authentication by default if you did not attach an SSH key at creation. Re-create the instance with `--ssh-keys`, or use the Vultr console (web dashboard) to access the instance.

### Out of memory (vc2-1c-2gb)

The second run of the bootstrap script adds 2 GB of swap. If the 2 GB plan still runs out of memory during Docker builds, make sure that the swap is active (`swapon --show`). If no swap is active, add it:

```sh
# Add swap
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

Then try again:

```sh
docker compose -f docker-compose.coordinator.yml up -d
```

If the problem continues, upgrade to `vc2-2c-4gb`:

```sh
vultr-cli instance update <instance-id> --plan vc2-2c-4gb
```
