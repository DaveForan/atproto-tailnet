# Deployment Guide

## Overview

atproto-tailnet supports two control-plane modes:

1. **Coordinator mode** (recommended): The Rust mesh coordinator does all
   Tailscale control-plane operations. It does not need the Docker socket.
   The coordinator, the TS service, and PostgreSQL can run as containers on
   any platform.

2. **Legacy Headscale mode**: This mode uses one Headscale Docker container
   for each tenant. The app manages the containers through the Docker socket.
   You must control the host.

### Requirements

#### Coordinator mode (recommended)

| Requirement | Details |
|-------------|---------|
| Runtime | Node.js 22+ |
| Database | PostgreSQL 16+ |
| Coordinator | Rust binary (`coordinator/`) or coordinator Docker image |
| Reverse proxy | Caddy 2 with admin API for dynamic subdomain routing |
| Ports | 80, 443 (Caddy), 3000 (app), 9443 (coordinator) |
| DNS | Wildcard record `*.ts.yourdomain.com` that points to the host |
| TLS | Caddy provisions certificates automatically through a pluggable strategy |

#### Legacy Headscale mode

| Requirement | Details |
|-------------|---------|
| Runtime | Node.js 22+ |
| Database | PostgreSQL 16+ |
| Docker socket | `/var/run/docker.sock` — the app uses it to manage Headscale containers |
| Reverse proxy | Caddy 2 with admin API for dynamic subdomain routing |
| Ports | 80, 443 (Caddy), 3000 (app), 10001-10100 (Headscale tenants) |
| Persistent storage | `./data/headscale/` — tenant configs and SQLite DBs |
| DNS | Wildcard record `*.ts.yourdomain.com` that points to the host |
| TLS | Caddy provisions certificates automatically through a pluggable strategy |

### Platform comparison

| Platform | Docker socket | Coordinator mode | Headscale mode |
|----------|:---:|:---:|:---:|
| EC2 / Droplet / VPS | Yes | Full stack | Full stack |
| Railway | No | Full stack | Web tier only |
| DO App Platform | No | Full stack | Web tier only |
| AWS ECS Fargate | No | Full stack | Web tier only |

---

## Environment variables

All configuration goes through `src/config.ts`, which Zod validates. The app
does not start in production if `SESSION_SECRET` is weak.

| Variable | Required | Default | Description |
|----------|:---:|---------|-------------|
| `DATABASE_URL` | Yes | `postgresql://atproto_tailnet:atproto_tailnet@localhost:5432/atproto_tailnet` | PostgreSQL connection string |
| `SESSION_SECRET` | Yes | -- | Session signing key (>= 32 chars in production) |
| `PORT` | No | `3000` | HTTP listen port |
| `PUBLIC_URL` | Yes | `http://localhost:3000` | Public URL (the app uses it in OAuth callbacks) |
| `BASE_DOMAIN` | Yes | `ts.localhost` | Base domain for tenant subdomains |
| `HEADSCALE_IMAGE` | No | `headscale/headscale:0.29.1` | Docker image for Headscale containers |
| `HEADSCALE_PORT_RANGE_START` | No | `10001` | First port in the Headscale allocation pool |
| `HEADSCALE_PORT_RANGE_END` | No | `10100` | Last port in the Headscale allocation pool |
| `HEADSCALE_DATA_DIR` | No | `./data/headscale` | Persistent storage for tenant Headscale data |
| `CADDY_ADMIN_URL` | No | `http://localhost:2019` | Caddy admin API endpoint |
| `LOG_LEVEL` | No | `info` | Pino log level (`debug`, `info`, `warn`, `error`) |
| `ATPROTO_PRIVATE_KEY` | Prod | -- | ES256 JWK for AT Proto OAuth (required for production) |
| `TLS_STRATEGY` | No | `on-demand` | TLS certificate strategy (see `caddy/tls-strategies/`) |
| `COORDINATOR_URL` | Coord | -- | URL of the Rust coordinator (e.g. `http://coordinator:9443`) |
| `COORDINATOR_API_KEY` | Coord | -- | Bearer token for the coordinator admin API (required when you set `COORDINATOR_URL`) |
| `APP_DOMAIN` | Yes | -- | Domain of the dashboard. Caddy uses it. The app does not derive it from `PUBLIC_URL` |
| `CADDY_DNS_PLUGINS` | DNS-01 | -- | Caddy DNS module for your `TLS_STRATEGY`, for example `github.com/caddy-dns/digitalocean` |
| `CADDY_CERTS_DIR` | Manual | `./caddy/certs` | Folder with `wildcard.pem` and `wildcard.key` for `TLS_STRATEGY=manual` |
| `WEBHOOK_ALLOW_PRIVATE` | No | `false` | Set `true` only for single-organisation self-hosting. It lets notification webhooks reach private addresses |
| `OPERATOR_DIDS` | Yes (production) | -- | Comma-separated DIDs of the instance operators, for example `did:plc:abc123`. Only operators (and the "tailnet creators" they designate) get a tailnet; everyone else who signs in sees invitations or can request to join the default tailnet. Operators get the operator API (`/api/operator/*`). If it is empty the app logs a loud warning and nobody can create a tailnet |
| `FEDERATION_ENABLED` | No | `false` | Shows federation (links between tailnets). Keep it off. Federation links carry no traffic in the coordinator stack yet |

#### Coordinator-side env vars (Rust binary)

| Variable | Required | Default | Description |
|----------|:---:|---------|-------------|
| `COORD_LISTEN` | No | `0.0.0.0:9443` | Coordinator listen address |
| `COORD_ADMIN_KEY` | Yes | -- | Bearer token for the admin API (must match `COORDINATOR_API_KEY` above) |
| `COORD_STORE_BACKEND` | Yes | -- | Storage backend: `memory`, `postgres`, or `sqlite` |
| `COORD_SQLITE_PATH` | SQLite | `coordinator.db` | Path to the SQLite database |
| `DATABASE_URL` | PG | -- | PostgreSQL connection string (when you use the postgres backend) |
| `COORD_CONTROL_KEY_PATH` | Yes | -- | File that holds the Noise control key. The coordinator creates it at first start. Keep it on a persistent volume. If the key changes, all clients must reconnect |
| `COORD_DERP_MAP` | No | -- | Path to the default DERP map JSON file. Each tenant can override it from the dashboard |

### Production `.env` example (coordinator mode)

```sh
DATABASE_URL=postgresql://atproto_tailnet:strong-password@postgres:5432/atproto_tailnet
SESSION_SECRET=a1b2c3d4e5f6...   # openssl rand -hex 32
PORT=3000
PUBLIC_URL=https://tailnets.yourdomain.com
BASE_DOMAIN=ts.yourdomain.com
COORDINATOR_URL=http://coordinator:9443
COORDINATOR_API_KEY=your-coordinator-api-key
CADDY_ADMIN_URL=http://caddy:2019
LOG_LEVEL=info
TLS_STRATEGY=on-demand
ATPROTO_PRIVATE_KEY={"kty":"EC","crv":"P-256",...}
OPERATOR_DIDS=did:plc:your-own-did
```

### Production `.env` example (legacy Headscale mode)

```sh
DATABASE_URL=postgresql://atproto_tailnet:strong-password@postgres:5432/atproto_tailnet
SESSION_SECRET=a1b2c3d4e5f6...   # openssl rand -hex 32
PORT=3000
PUBLIC_URL=https://tailnets.yourdomain.com
BASE_DOMAIN=ts.yourdomain.com
HEADSCALE_IMAGE=headscale/headscale:0.29.1
HEADSCALE_PORT_RANGE_START=10001
HEADSCALE_PORT_RANGE_END=10100
HEADSCALE_DATA_DIR=/data/headscale
CADDY_ADMIN_URL=http://caddy:2019
LOG_LEVEL=info
TLS_STRATEGY=on-demand
ATPROTO_PRIVATE_KEY={"kty":"EC","crv":"P-256",...}
OPERATOR_DIDS=did:plc:your-own-did
```

---

## Pre-deployment checklist (DigitalOcean, coordinator mode)

1. Add DNS records for `APP_DOMAIN` and the wildcard `*.BASE_DOMAIN`. Point both at the Droplet.
2. Create a DigitalOcean API token with read and write scope. Set `TLS_STRATEGY=digitalocean`, `DO_AUTH_TOKEN` and `CADDY_DNS_PLUGINS=github.com/caddy-dns/digitalocean`.
3. Generate strong values for `SESSION_SECRET` (`openssl rand -hex 32`), `POSTGRES_PASSWORD` and `COORDINATOR_API_KEY`. The stack does not start without them.
4. Generate an ES256 JWK for `ATPROTO_PRIVATE_KEY`. Bluesky sign-in needs it in production.
5. Set `PUBLIC_URL=https://APP_DOMAIN`.
6. Keep `FEDERATION_ENABLED` unset.
7. Set `OPERATOR_DIDS` to your own DID (find it with `curl "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=you.bsky.social"`). Without it the instance has no operator and nobody gets a tailnet. Strangers who sign in get no tailnet: they only see their invitations, or can request to join your default tailnet.
8. Run `deploy/digitalocean/droplet-setup.sh`. Then open `https://APP_DOMAIN` and sign in as the operator. Your first tailnet becomes the instance's default tailnet and accepts join requests. You can change both in the operator settings, turn on single-tailnet mode, or designate other tailnet creators.

The coordinator stores its Noise control key on the `coord_data` volume. Keep that volume. If you lose it, every device must reconnect.

---

## TLS and wildcard DNS with Caddy

Caddy terminates TLS with Let's Encrypt certificates. The TLS strategy is
pluggable. Set `TLS_STRATEGY` in `.env` to choose how Caddy obtains
certificates. Each strategy is a directory in `caddy/tls-strategies/`. The
files in each directory document the requirements of the strategy.

### DNS records

| Type | Name | Value |
|------|------|-------|
| A | `tailnets.yourdomain.com` | `<server IP>` |
| A | `*.ts.yourdomain.com` | `<server IP>` |

### TLS strategies

| Strategy | How it works | DNS credentials needed |
|----------|-------------|----------------------|
| `on-demand` (default) | Per-tenant cert on first connection | None |
| `cloudflare` | DNS-01 wildcard | `CF_API_TOKEN` |
| `route53` | DNS-01 wildcard | AWS credentials |
| `digitalocean` | DNS-01 wildcard | `DO_AUTH_TOKEN` |
| `rfc2136` | DNS-01 wildcard | TSIG keys (BIND/Knot/PowerDNS) |
| `acmedns` | DNS-01 wildcard through delegation | acme-dns credentials + one CNAME |
| `hetzner` | DNS-01 wildcard | `HETZNER_API_TOKEN` |
| `vultr` | DNS-01 wildcard | `VULTR_API_KEY` |
| `manual` | Use your own wildcard cert | None |

DNS-01 strategies need a Caddy image that includes the DNS module. Set
`CADDY_DNS_PLUGINS` in `.env` to the Go module path (e.g.,
`github.com/caddy-dns/route53`). The `on-demand` and `manual` strategies
use stock Caddy and do not need a build step.

### Caddyfile

The production Caddyfile (`Caddyfile.production`) imports the TLS strategy from
a mounted directory (`/etc/caddy/tls-strategy/`). The compose files mount the
correct strategy automatically, based on `TLS_STRATEGY`. Set `APP_DOMAIN` and
`BASE_DOMAIN` in `.env`. You do not need to edit the Caddyfile.

---

## Docker Compose — Coordinator mode (recommended)

The coordinator stack runs all services as containers. It does not need the
Docker socket:

```sh
git clone https://github.com/your-org/atproto-tailnet.git
cd atproto-tailnet

cp .env.coordinator.example .env
# Edit .env with production values (COORDINATOR_API_KEY, SESSION_SECRET, etc.)

docker compose -f docker-compose.coordinator.yml up -d
```

This command starts the TS service, the Rust coordinator, PostgreSQL, and
Caddy. The coordinator manages all tenants and the DERP relay configuration.
Each tenant sets its own DERP relays in the dashboard. The service stores the
settings and sends them to the coordinator for that tenant only. Connected
devices receive the new relay map immediately. You do not need to restart the
stack.

### Updating

```sh
git pull
docker compose -f docker-compose.coordinator.yml build
docker compose -f docker-compose.coordinator.yml up -d
```

---

## Docker Compose — Legacy Headscale mode

Use this mode for deployments that use one Headscale container for each
tenant:

```sh
git clone https://github.com/your-org/atproto-tailnet.git
cd atproto-tailnet

cp .env.example .env
# Edit .env with production values

docker compose -f docker-compose.production.yml up -d
```

This command starts the app, PostgreSQL, and Caddy. The app accesses the Docker
socket through a bind mount. The app can then create Headscale containers on
the host.

### Updating

```sh
git pull
docker compose -f docker-compose.production.yml build app
docker compose -f docker-compose.production.yml up -d app
```

### Viewing logs

```sh
docker compose -f docker-compose.production.yml logs -f app
```

---

## Platform-specific guides

These guides give detailed setup instructions for each platform:

- **Railway**: [`deploy/railway/README.md`](../deploy/railway/README.md)
- **DigitalOcean**: [`deploy/digitalocean/README.md`](../deploy/digitalocean/README.md)
- **AWS**: [`deploy/aws/README.md`](../deploy/aws/README.md)

---

## Health check

The app has a `GET /health` endpoint. It returns `200 OK` when the service and
the database connection are healthy. Use it for load balancer health checks
and deployment readiness probes.

```sh
curl -f https://tailnets.yourdomain.com/health
```

---

## Backups

### PostgreSQL

```sh
# Manual dump
docker compose -f docker-compose.production.yml \
  exec -T postgres pg_dump -U atproto_tailnet atproto_tailnet | gzip > backup.sql.gz

# Restore
gunzip -c backup.sql.gz | docker compose -f docker-compose.production.yml \
  exec -T postgres psql -U atproto_tailnet atproto_tailnet
```

### Headscale data

The `HEADSCALE_DATA_DIR` directory contains the configuration files and SQLite
databases of each tenant. Back up the complete directory:

```sh
tar czf headscale-backup-$(date +%Y%m%d).tar.gz /data/headscale/
```

---

## Security considerations

- `SESSION_SECRET` must be a cryptographically random string of 32 characters
  or more.
- `ATPROTO_PRIVATE_KEY` is an ES256 JWK. Keep it in a secrets manager. Do not
  keep it in version control.
- `COORDINATOR_API_KEY` and `COORD_ADMIN_KEY` must be equal and strong. This
  key protects all admin operations on the coordinator.
- **Coordinator mode**: The coordinator listens on port 9443. Use a firewall
  to let only the TS service reach it. Do not let the public internet reach
  it. The coordinator admin API uses constant-time Bearer token authentication.
- **Headscale mode**: The Docker socket mount gives the app root-equivalent
  access to the host. Harden the host and make sure the app is the only
  consumer. Use a firewall to let only Tailscale protocol traffic (DERP/STUN)
  reach the Headscale ports (10001-10100).
- The app has built-in rate limiting (10 req/min for auth, 60 req/min for the
  API).
- The coordinator limits the request body to 2 MiB on all routes.
- The dashboard HTML-escapes all user-controlled data.
- CSP: `script-src 'self'; style-src 'self'`
