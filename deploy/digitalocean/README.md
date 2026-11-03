# Deploying atproto-tailnet on DigitalOcean

There are two deployment options on DigitalOcean. The Droplet approach is
**recommended** because it provides Docker socket access, which is required for
per-tenant Headscale container orchestration.

## Option 1: Droplet (recommended)

A single Droplet runs the full stack via Docker Compose. This gives you Docker
socket access, persistent volumes, and full control over the host.

### Prerequisites

- DigitalOcean account
- A domain with DNS pointed to DigitalOcean (or Cloudflare)
- Wildcard DNS record: `*.ts.yourdomain.com` pointing to the Droplet IP

### Create the Droplet

Via CLI:

```sh
doctl compute droplet create atproto-tailnet \
  --region nyc1 \
  --size s-2vcpu-2gb \
  --image ubuntu-22-04-x64 \
  --ssh-keys <your-ssh-key-id>
```

Or via the DigitalOcean dashboard -- choose Ubuntu 22.04, 2 GB RAM minimum.

### Bootstrap

```sh
# From your local machine:
ssh root@<droplet-ip> 'bash -s' < deploy/digitalocean/droplet-setup.sh
```

The script will:
1. Install Docker and Docker Compose
2. Clone the repository
3. Create `.env` from the example (you must edit it)
4. Build and start the production stack

After the script runs, SSH in and edit `.env`:

```sh
ssh root@<droplet-ip>
cd /opt/atproto-tailnet
nano .env

# Then start:
docker compose -f docker-compose.production.yml up -d
```

### Required environment variables

| Variable | Description |
|----------|-------------|
| `SESSION_SECRET` | Random string >= 32 characters (`openssl rand -hex 32`) |
| `POSTGRES_PASSWORD` | PostgreSQL password |
| `PUBLIC_URL` | `https://tailnets.yourdomain.com` |
| `BASE_DOMAIN` | `ts.yourdomain.com` |
| `CF_API_TOKEN` | Cloudflare API token for DNS-01 TLS challenges |
| `ATPROTO_PRIVATE_KEY` | ES256 JWK for AT Proto OAuth (production) |

### Firewall

```sh
ufw allow 22/tcp          # SSH
ufw allow 80/tcp          # HTTP redirect
ufw allow 443/tcp         # HTTPS
ufw allow 443/udp         # HTTP/3
ufw allow 10001:10100/tcp # Headscale tenant ports
ufw --force enable
```

### Monitoring

```sh
# Logs
docker compose -f docker-compose.production.yml logs -f

# Health check
curl https://tailnets.yourdomain.com/health

# Resource usage
docker stats
```

### Backups

Enable DigitalOcean Droplet backups ($1/month) and set up periodic Postgres
dumps:

```sh
# Add to crontab:
0 3 * * * docker compose -f /opt/atproto-tailnet/docker-compose.production.yml \
  exec -T postgres pg_dump -U atproto_tailnet atproto_tailnet | \
  gzip > /opt/backups/db-$(date +\%Y\%m\%d).sql.gz
```

### Cost estimate

- **s-2vcpu-2gb Droplet**: $18/month
- **Droplet backups**: $3.60/month
- **Total**: ~$22/month

---

## Option 2: App Platform (limited)

DigitalOcean App Platform provides managed deployments with built-in Postgres,
but **does not provide Docker socket access**. This means Headscale container
orchestration will not work natively.

Use this only if you plan to run Headscale containers on a separate host and
connect via a remote Docker daemon.

### Deploy

```sh
doctl apps create --spec deploy/digitalocean/.do/app.yaml
```

### Limitations

- No Docker socket -- cannot create/manage Headscale containers
- No host-level port binding -- Headscale ports 10001-10100 unavailable
- No wildcard TLS -- need external proxy for `*.ts.yourdomain.com`
- No persistent filesystem -- Headscale data dir requires external storage

### Hybrid approach

1. Deploy the web tier on App Platform (app + managed Postgres)
2. Run a small Droplet for Headscale containers
3. Set `DOCKER_HOST=tcp://<droplet-ip>:2376` on the App Platform service
4. Secure the remote Docker socket with TLS client certificates

### Cost estimate

- **App Platform basic**: $5/month
- **Managed Postgres (dev)**: $7/month
- **Companion Droplet**: $6/month
- **Total**: ~$18/month
