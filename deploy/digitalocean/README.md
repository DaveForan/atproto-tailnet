# Deploying atproto-tailnet on DigitalOcean

DigitalOcean has two deployment options. The Droplet approach is
**recommended**. One Droplet runs the full stack
(`docker-compose.coordinator.yml`): the TypeScript service, the Rust
coordinator, PostgreSQL and Caddy. The service does not need the
Docker socket.

## Option 1: Droplet (recommended)

For the full procedure, see
[First deployment on DigitalOcean](../../docs/deployment.md#first-deployment-on-digitalocean)
and [Droplet hardening](../../docs/deployment.md#droplet-hardening). For
commands that an agent can run without help, see [`AGENT.md`](AGENT.md).

### Prerequisites

- A DigitalOcean account
- A domain in DigitalOcean DNS
- An A record for `APP_DOMAIN` (for example `tailnets.example.com`) that points to the Droplet IP
- A wildcard A record `*.ts.example.com` that points to the Droplet IP
- A DigitalOcean API token for Caddy. If possible, limit it to the `domain` scopes
- Your Bluesky DID for `OPERATOR_DIDS`

### Create the Droplet

Via CLI:

```sh
doctl compute droplet create atproto-tailnet \
  --region nyc1 \
  --size s-2vcpu-2gb \
  --image ubuntu-22-04-x64 \
  --ssh-keys <your-ssh-key-id>
```

Or use the DigitalOcean dashboard. Choose Ubuntu 22.04 and a minimum of 2 GB RAM. Use an SSH key, not a password.

### Bootstrap

```sh
# From your local machine:
ssh root@<droplet-ip> "REPO_URL=https://github.com/<you>/atproto-tailnet.git bash -s" < deploy/digitalocean/droplet-setup.sh
```

On the first run, the script does these steps:

1. It installs Docker, the Compose plugin and git.
2. It clones the repository to `/opt/atproto-tailnet`.
3. It creates `.env` from `.env.coordinator.example`.
4. It generates `SESSION_SECRET`, `POSTGRES_PASSWORD`, `COORDINATOR_API_KEY` and `FEDERATION_KEY_ENCRYPTION_KEY`, and it sets the file mode to `600`.
5. It stops, so that you can edit `.env`.

Then SSH in and edit `.env`:

```sh
ssh root@<droplet-ip>
cd /opt/atproto-tailnet
nano .env
```

Generate `ATPROTO_PRIVATE_KEY` as described in the
[deployment guide](../../docs/deployment.md#5-generate-the-oauth-key). Then
start the stack:

```sh
docker compose -f docker-compose.coordinator.yml up -d
```

Open `https://<APP_DOMAIN>` and sign in as the operator before anyone else.

### Required environment variables

| Variable | Description |
|----------|-------------|
| `OPERATOR_DIDS` | Your DID (`did:plc:...`). Only operators get a tailnet. Set it before the first sign-in |
| `PUBLIC_URL` | `https://tailnets.yourdomain.com` |
| `APP_DOMAIN` | `tailnets.yourdomain.com` |
| `BASE_DOMAIN` | `ts.yourdomain.com` |
| `TLS_STRATEGY` | `digitalocean` |
| `DO_AUTH_TOKEN` | DigitalOcean API token for DNS-01 TLS challenges |
| `CADDY_DNS_PLUGINS` | `github.com/caddy-dns/digitalocean` |
| `ATPROTO_PRIVATE_KEY` | ES256 JWK for AT Proto OAuth, between single quotes |
| `SESSION_SECRET`, `POSTGRES_PASSWORD`, `COORDINATOR_API_KEY`, `FEDERATION_KEY_ENCRYPTION_KEY` | The setup script generates them |

Keep `FEDERATION_ENABLED` unset. Federation is off by default.

### Firewall

Docker-published ports (80 and 443) bypass `ufw`. Use a DigitalOcean Cloud
Firewall with these inbound rules:

- TCP 22 from your IP address only
- TCP 80
- TCP 443
- UDP 443

The coordinator (9443), the app (3000) and PostgreSQL are not published. For
the `doctl` command, see
[Droplet hardening](../../docs/deployment.md#cloud-firewall).

### Monitoring

```sh
# Logs
docker compose -f docker-compose.coordinator.yml logs -f

# Health check
curl https://tailnets.yourdomain.com/health

# Resource usage
docker stats
```

### Backups

Enable DigitalOcean Droplet backups. Also back up the `pgdata` and
`coord_data` volumes. `coord_data` holds the coordinator control key. If you
lose it, every device must register again.

```sh
# Add to crontab (create /opt/backups first):
0 3 * * * docker compose -f /opt/atproto-tailnet/docker-compose.coordinator.yml \
  exec -T postgres pg_dump -U atproto_tailnet atproto_tailnet | \
  gzip > /opt/backups/db-$(date +\%Y\%m\%d).sql.gz
```

To copy the control key, see
[Backups](../../docs/deployment.md#backups).

### Cost estimate

- **s-2vcpu-2gb Droplet**: $18/month
- **Droplet backups**: $3.60/month
- **Total**: ~$22/month

---

## Option 2: App Platform (limited)

DigitalOcean App Platform gives managed deployments with built-in Postgres.
The spec in `deploy/digitalocean/.do/app.yaml` deploys only the web tier.
The spec does not run the coordinator, the relay or Caddy. The service refuses
to start without `COORDINATOR_URL` and `COORDINATOR_API_KEY`, so you must run
a coordinator yourself and set both. The spec does not set `OPERATOR_DIDS` or
`TRUST_PROXY`. Add them before you use it.

Use the Droplet option for a working instance.

### Deploy

```sh
doctl apps create --spec deploy/digitalocean/.do/app.yaml
```

### Limitations

- No coordinator: you must run the Rust coordinator and the relay elsewhere
- No wildcard TLS: you need an external proxy for `*.ts.yourdomain.com`

### Cost estimate

- **App Platform basic**: $5/month
- **Managed Postgres (dev)**: $7/month
- **Total**: ~$12/month (web tier only)
