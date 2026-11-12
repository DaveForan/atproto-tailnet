# Deployment Guide

## Overview

atproto-tailnet is a TypeScript/Express application that manages per-tenant
Headscale containers via the Docker socket. This architectural choice is the
primary constraint driving deployment decisions: **the app must run on a host
with Docker socket access**.

Managed container platforms (Railway, DigitalOcean App Platform, AWS Fargate)
run your app in isolated environments without Docker socket access. These
platforms can host the web tier, but Headscale orchestration must run on a host
you control (a VPS, Droplet, or EC2 instance).

### Requirements

| Requirement | Details |
|-------------|---------|
| Runtime | Node.js 22+ |
| Database | PostgreSQL 16+ |
| Docker socket | `/var/run/docker.sock` -- manages Headscale containers |
| Reverse proxy | Caddy 2 with admin API for dynamic subdomain routing |
| Ports | 80, 443 (Caddy), 3000 (app), 10001-10100 (Headscale tenants) |
| Persistent storage | `./data/headscale/` -- tenant configs and SQLite DBs |
| DNS | Wildcard record `*.ts.yourdomain.com` pointing to the host |
| TLS | Caddy auto-provisions via pluggable strategy (on-demand, DNS-01 wildcard, or manual) |

### Platform comparison

| Platform | Docker socket | Recommended | Notes |
|----------|:---:|:---:|-------|
| EC2 / Droplet / VPS | Yes | Yes | Full stack on one box |
| Railway | No | Partial | Web tier only; Headscale externally |
| DO App Platform | No | Partial | Web tier only; Headscale externally |
| AWS ECS Fargate | No | Partial | Web tier only; Headscale externally |

---

## Environment variables

All configuration flows through `src/config.ts` (Zod-validated). The app refuses
to start in production if `SESSION_SECRET` is weak.

| Variable | Required | Default | Description |
|----------|:---:|---------|-------------|
| `DATABASE_URL` | Yes | `postgresql://atproto_tailnet:atproto_tailnet@localhost:5432/atproto_tailnet` | PostgreSQL connection string |
| `SESSION_SECRET` | Yes | -- | Session signing key (>= 32 chars in production) |
| `PORT` | No | `3000` | HTTP listen port |
| `PUBLIC_URL` | Yes | `http://localhost:3000` | Public-facing URL (used in OAuth callbacks) |
| `BASE_DOMAIN` | Yes | `ts.localhost` | Base domain for tenant subdomains |
| `HEADSCALE_IMAGE` | No | `headscale/headscale:0.29.1` | Docker image for Headscale containers |
| `HEADSCALE_PORT_RANGE_START` | No | `10001` | First port in the Headscale allocation pool |
| `HEADSCALE_PORT_RANGE_END` | No | `10100` | Last port in the Headscale allocation pool |
| `HEADSCALE_DATA_DIR` | No | `./data/headscale` | Persistent storage for tenant Headscale data |
| `CADDY_ADMIN_URL` | No | `http://localhost:2019` | Caddy admin API endpoint |
| `LOG_LEVEL` | No | `info` | Pino log level (`debug`, `info`, `warn`, `error`) |
| `ATPROTO_PRIVATE_KEY` | Prod | -- | ES256 JWK for AT Proto OAuth (required for production) |
| `TLS_STRATEGY` | No | `on-demand` | TLS certificate strategy (see `caddy/tls-strategies/`) |

### Production `.env` example

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
```

---

## TLS and wildcard DNS with Caddy

Caddy handles TLS termination using Let's Encrypt certificates. The TLS
strategy is pluggable — set `TLS_STRATEGY` in `.env` to choose how certificates
are obtained. Each strategy is a directory in `caddy/tls-strategies/` with its
requirements documented in the files.

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
| `acmedns` | DNS-01 wildcard via delegation | acme-dns credentials + one CNAME |
| `hetzner` | DNS-01 wildcard | `HETZNER_API_TOKEN` |
| `vultr` | DNS-01 wildcard | `VULTR_API_KEY` |
| `manual` | Bring your own wildcard cert | None |

DNS-01 strategies need the Caddy image built with the DNS module. Set
`CADDY_DNS_PLUGINS` in `.env` to the Go module path (e.g.,
`github.com/caddy-dns/route53`). The `on-demand` and `manual` strategies
use stock Caddy with no build step.

### Caddyfile

The production Caddyfile (`Caddyfile.production`) imports the TLS strategy from
a mounted directory (`/etc/caddy/tls-strategy/`). The compose files
automatically mount the correct strategy based on `TLS_STRATEGY`. Set
`APP_DOMAIN` and `BASE_DOMAIN` in `.env` — no Caddyfile editing needed.

---

## Docker Compose (simplest full deployment)

The recommended approach for a single-server deployment:

```sh
# On your server
git clone https://github.com/your-org/atproto-tailnet.git
cd atproto-tailnet

cp .env.example .env
# Edit .env with production values

docker compose -f docker-compose.production.yml up -d
```

This starts the app, PostgreSQL, and Caddy. The app gets Docker socket access
via bind mount and can create Headscale containers on the host.

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

Detailed setup instructions for each platform:

- **Railway**: [`deploy/railway/README.md`](../deploy/railway/README.md)
- **DigitalOcean**: [`deploy/digitalocean/README.md`](../deploy/digitalocean/README.md)
- **AWS**: [`deploy/aws/README.md`](../deploy/aws/README.md)

---

## Health check

The app exposes `GET /health` which returns `200 OK` when the service and
database connection are healthy. Use this for load balancer health checks and
deployment readiness probes.

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

The `HEADSCALE_DATA_DIR` contains per-tenant configuration files and SQLite
databases. Back up the entire directory:

```sh
tar czf headscale-backup-$(date +%Y%m%d).tar.gz /data/headscale/
```

---

## Security considerations

- `SESSION_SECRET` must be a cryptographically random string >= 32 characters
- `ATPROTO_PRIVATE_KEY` is an ES256 JWK -- store it in a secrets manager, not
  in version control
- The Docker socket mount gives the app root-equivalent access to the host --
  ensure the host is hardened and the app is the only consumer
- Headscale ports (10001-10100) should be firewalled to only allow Tailscale
  protocol traffic (DERP/STUN)
- Rate limiting is built into the app (10 req/min auth, 60 req/min API)
- All user-controlled data is HTML-escaped in the dashboard
