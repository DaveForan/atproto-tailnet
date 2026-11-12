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

## Caddy

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CADDY_ADMIN_URL` | No | `http://localhost:2019` | Caddy admin API URL for dynamic route management |
| `CF_API_TOKEN` | Production | --- | Cloudflare API token for wildcard TLS via DNS-01 challenge |

## Coordinator binary configuration

The Rust coordinator has its own configuration, separate from the TypeScript service. It reads a TOML file (first CLI argument) and environment variables (which take precedence).

### TOML file

```toml
listen = "127.0.0.1:9443"
domain = "mesh.local"
# derp_map_file = "/etc/coordinator/derp-map.json"
# database_url = "postgres://coord:coord@localhost/coordinator"
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `COORD_LISTEN` | `127.0.0.1:9443` | Listen address (overrides TOML `listen`) |
| `COORD_ADMIN_KEY` | *(none)* | Admin API bearer token. When unset, admin endpoints have no authentication |
| `COORD_DERP_MAP` | *(none)* | Path to JSON DERP map file (overrides TOML `derp_map_file`) |
| `DATABASE_URL` | *(none)* | PostgreSQL URL. When set, uses PgStore and runs migrations at startup. When unset, uses in-memory store |
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
| `Caddyfile.production` | Legacy prod | HTTPS with Cloudflare DNS-01 wildcard TLS |
| `Caddyfile.coordinator.production` | Coordinator prod | HTTPS with Cloudflare DNS-01 wildcard TLS |

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
- [ ] `CF_API_TOKEN` is set for Cloudflare wildcard TLS (or adjust Caddyfile for your DNS provider)
- [ ] PostgreSQL has a strong password and is not exposed to the internet
- [ ] Caddy is the only service bound to ports 80/443
- [ ] `COORD_ADMIN_KEY` is set on the coordinator (otherwise admin API is unauthenticated)
