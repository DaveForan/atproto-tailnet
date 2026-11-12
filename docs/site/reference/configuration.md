---
title: Configuration Reference
---

# Configuration Reference

All configuration flows through environment variables, validated at startup by a Zod schema in `src/config.ts`. Invalid configuration causes an immediate exit with a descriptive error.

## Core settings

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | --- | PostgreSQL connection string |
| `SESSION_SECRET` | Yes | --- | Session signing key. Must be at least 32 characters for non-loopback deployments |
| `PORT` | No | `3000` | HTTP listen port for the TypeScript service |
| `PUBLIC_URL` | No | `http://127.0.0.1:3000` | Public-facing URL. Must use an IP address or real domain (not `localhost`) for AT Proto OAuth |
| `BASE_DOMAIN` | No | `ts.localhost` | Wildcard domain for tenant subdomains. Tenant URLs are `<slug>.<BASE_DOMAIN>` |
| `TENANT_PUBLIC_PORT` | No | *(from URL)* | Port included in device connection URLs. Set to `8180` for local dev with Caddy |
| `LOG_LEVEL` | No | `info` | Pino log level: `debug`, `info`, `warn`, `error` |

## Coordinator mode

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `COORDINATOR_URL` | No | --- | Enables coordinator mode when set. URL of the Rust coordinator (e.g., `http://coordinator:9443`) |
| `COORDINATOR_API_KEY` | When `COORDINATOR_URL` set | --- | Bearer token for coordinator admin API |

## Legacy Headscale mode

These are only used when `COORDINATOR_URL` is **not** set:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HEADSCALE_IMAGE` | No | `headscale/headscale:0.29.1` | Docker image for tenant Headscale containers |
| `HEADSCALE_PORT_RANGE_START` | No | `10001` | First port in the allocation pool |
| `HEADSCALE_PORT_RANGE_END` | No | `10100` | Last port (inclusive) |
| `HEADSCALE_DATA_DIR` | No | `./data/headscale` | Host directory for persistent Headscale data |
| `HEADSCALE_NETWORK` | No | `atproto-tailnet-tenants` | Docker network shared with Caddy |

## Authentication

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ATPROTO_PRIVATE_KEY` | Production only | --- | ES256 private key in JWK format for AT Proto OAuth client authentication. Not needed for local development (ephemeral keys are generated) |

## Federation

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FEDERATION_KEY_ENCRYPTION_KEY` | For federation | --- | 64 hex characters (32 bytes). AES-256-GCM key for encrypting collective signing keys at rest |

## Caddy and TLS

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CADDY_ADMIN_URL` | No | `http://localhost:2019` | Caddy admin API URL for dynamic route management |
| `TLS_STRATEGY` | No | `on-demand` | TLS certificate strategy. See [TLS strategies](#tls-strategies) below |
| `APP_DOMAIN` | No | `tailnets.example.com` | Domain for the main app (dashboard, auth, API) |
| `CADDY_DNS_PLUGINS` | When DNS-01 | --- | Space-separated Go module paths for Caddy DNS modules (e.g., `github.com/caddy-dns/route53`) |

### TLS strategies

The `TLS_STRATEGY` variable selects how Caddy obtains certificates for tenant subdomains. Each strategy is a directory in `caddy/tls-strategies/` containing `global.caddy` and `site.caddy` snippets that the production Caddyfile imports.

| Strategy | Type | DNS credentials | Caddy module needed | Notes |
|----------|------|-----------------|---------------------|-------|
| `on-demand` | Per-tenant certs | None | None | Default. Caddy issues individual certs on first connection. Requires `/internal/tls-check` endpoint (built-in) |
| `cloudflare` | Wildcard | `CF_API_TOKEN` | `caddy-dns/cloudflare` | |
| `route53` | Wildcard | `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `caddy-dns/route53` | Instance roles also work (no key env vars) |
| `digitalocean` | Wildcard | `DO_AUTH_TOKEN` | `caddy-dns/digitalocean` | |
| `rfc2136` | Wildcard | `RFC2136_SERVER`, `RFC2136_KEY_NAME`, `RFC2136_KEY` | `caddy-dns/rfc2136` | BIND, Knot DNS, PowerDNS |
| `acmedns` | Wildcard | `ACMEDNS_SERVER_URL`, `ACMEDNS_USERNAME`, `ACMEDNS_PASSWORD`, `ACMEDNS_SUBDOMAIN` | `caddy-dns/acmedns` | One-time CNAME setup |
| `manual` | Wildcard | None | None | Bring your own cert. Mount at `/etc/caddy/certs/` |

**Choosing a strategy:** `on-demand` is the simplest — no DNS provider API access required, no extra Caddy modules. DNS-01 strategies issue a single wildcard certificate which is faster for many tenants. `rfc2136` and `acmedns` work with self-hosted DNS and avoid all cloud provider dependencies. `manual` is for environments with existing certificate management.

## Coordinator binary configuration

The Rust coordinator has its own configuration, separate from the TypeScript service. It reads a TOML file (first CLI argument) and environment variables (which take precedence).

### TOML file

```toml
listen = "127.0.0.1:9443"
domain = "mesh.local"
store_backend = "sqlite"      # "sqlite", "postgres", or "memory"
# sqlite_path = "./coordinator.db"
# database_url = "postgres://coord:coord@localhost/coordinator"
# derp_map_file = "/etc/coordinator/derp-map.json"
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `COORD_STORE_BACKEND` | *(required)* | Storage backend: `sqlite`, `postgres`, or `memory` (overrides TOML `store_backend`) |
| `COORD_LISTEN` | `127.0.0.1:9443` | Listen address (overrides TOML `listen`) |
| `COORD_ADMIN_KEY` | *(none)* | Admin API bearer token. When unset, admin endpoints have no authentication |
| `COORD_SQLITE_PATH` | `coordinator.db` | SQLite database file path (used when backend = `sqlite`) |
| `COORD_DERP_MAP` | *(none)* | Path to JSON DERP map file (overrides TOML `derp_map_file`) |
| `DATABASE_URL` | *(none)* | PostgreSQL URL (required when backend = `postgres`) |
| `RUST_LOG` | `info` | Rust logging filter (e.g., `coordinator=debug,coord_api=trace`) |

## Docker Compose files

| File | Mode | Use case |
|------|------|----------|
| `docker-compose.yml` | Legacy Headscale | Local development |
| `docker-compose.coordinator.dev.yml` | Coordinator | Local development |
| `docker-compose.coordinator.yml` | Coordinator | Production |
| `docker-compose.production.yml` | Legacy Headscale | Production |

## Caddyfiles

| File | Mode | Description |
|------|------|-------------|
| `Caddyfile` | Legacy dev | HTTP on `:80`, proxies to `host.docker.internal:3000` |
| `Caddyfile.coordinator` | Coordinator dev | HTTP on `:80`, proxies to `app:3000` |
| `Caddyfile.production` | Legacy prod | HTTPS with pluggable TLS strategy (imports from mounted `tls-strategy/`) |
| `Caddyfile.coordinator.production` | Coordinator prod | HTTPS with pluggable TLS strategy (imports from mounted `tls-strategy/`) |

All Caddyfiles name the server `tailnet_proxy`. The TypeScript service dynamically manages one route (`@id: tailnet_tenants`) via the Caddy admin API to route tenant subdomains to the correct backend.

## npm scripts

| Script | Command | Description |
|--------|---------|-------------|
| `npm run dev` | `tsx watch --env-file=.env src/index.ts` | Development server with hot reload |
| `npm run build` | `tsc` | Compile TypeScript to `dist/` |
| `npm start` | `node dist/index.js` | Production server |
| `npx drizzle-kit generate` | --- | Generate database migration from schema changes |
| `npx drizzle-kit migrate` | --- | Apply pending migrations |
| `npx drizzle-kit studio` | --- | Open Drizzle Studio (database browser) |

## Production checklist

- [ ] `SESSION_SECRET` is a unique random string, at least 32 characters
- [ ] `PUBLIC_URL` is your real HTTPS domain
- [ ] `BASE_DOMAIN` has wildcard DNS pointing to your server
- [ ] `COORDINATOR_API_KEY` / `COORD_ADMIN_KEY` are strong random values (matching)
- [ ] `FEDERATION_KEY_ENCRYPTION_KEY` is 64 random hex characters (if using federation)
- [ ] `ATPROTO_PRIVATE_KEY` is set (generate with AT Proto tooling)
- [ ] `TLS_STRATEGY` is set and the required env vars for that strategy are provided (see [TLS strategies](#tls-strategies))
- [ ] PostgreSQL has a strong password and is not exposed to the internet
- [ ] Caddy is the only service bound to ports 80/443
- [ ] `COORD_ADMIN_KEY` is set on the coordinator (otherwise admin API is unauthenticated)
