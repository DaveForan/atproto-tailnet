# atproto-tailnet

Create private mesh networks using your Bluesky identity. Sign in with your AT Protocol handle, get an isolated [Tailscale](https://tailscale.com)-compatible network, and invite others by their `@handle`.

Built on a purpose-built Rust mesh coordinator (replacing [Headscale](https://github.com/juanfont/headscale)) with a TypeScript service layer for auth, orchestration, and the dashboard.

## How it works

1. **Sign in** with your Bluesky handle via AT Protocol OAuth
2. **Get a tailnet** — a private Headscale instance spins up automatically
3. **Connect devices** — standard `tailscale up --login-server <your-url>` 
4. **Invite others** by their `@handle.bsky.social` — they sign in and join your network
5. **Manage access** — roles, permissions, device approval, lockdown mode

## Features

- **AT Protocol auth** — no passwords, no accounts to create. Your Bluesky DID is your identity.
- **Isolated networks** — each tenant gets its own Headscale container, port, and subdomain
- **Role-based access** — 15 granular permissions, custom roles, originator protection
- **Device approval** — optional gate on new device connections
- **Device locking** — bind members to specific machines
- **Lockdown mode** — emergency freeze on all joins, invitations, and new devices
- **Service registry** — register services on your network, publish them to a public board
- **Public board** — `/board/<slug>` page for advertising services to the world
- **Join requests** — public `/join/<slug>` page so people can request access
- **ACL management** — visual editor for Headscale access control rules, groups, and hosts
- **Custom DERP relays** — per-tenant relay regions, embedded DERP server toggle, public relay control
- **IP range configuration** — per-tenant IPv4/IPv6 CIDR prefixes and allocation strategy
- **Exit nodes & subnet routers** — approve, enable, disable, and delete advertised routes
- **Usage metering** — live device/member/route counts, plan limits, 7-day usage history snapshots
- **Federation** — request, accept, reject, and revoke trust links between collectives with signed handshakes, CIDR route exchange, replay protection, and rate limiting
- **Agent API tokens** — scoped Bearer tokens for AI agents and automation
- **Health monitoring** — background checks with auto-restart for failed instances
- **Instance hibernation** — auto-stop idle tenants after configurable days of inactivity
- **Structured logging** — Pino-based JSON logs with configurable level
- **Full audit log** — every security-relevant action recorded with metadata
- **Inline dashboard** — single-page app served from the backend, no separate frontend build

## Architecture

| Layer | Technology |
|-------|-----------|
| Coordinator | Rust (8-crate workspace: coord-core, coord-noise, coord-proto, coord-acl, coord-store, coord-netmap, coord-federation, coord-api) |
| Service layer | TypeScript / Express 5 / Drizzle ORM |
| Database | PostgreSQL (shared by coordinator and service) |
| Auth | `@atproto/oauth-client-node` |
| Control plane | Rust coordinator (Noise IK protocol, multi-tenant, federation) or Headscale (legacy, one Docker container per tenant) |
| Federation | Collective Federation Protocol (CFP) — JSON over HTTP/2, DID-based identity, signed handshakes, CIDR route exchange |
| Reverse proxy | Caddy (dynamic subdomains via admin API) |

The coordinator speaks the Tailscale control protocol (Noise IK handshake, register/map over HTTP/2) and adds native multi-tenancy, federation between collectives, and sub-collective hierarchy. The TypeScript service handles AT Proto OAuth, the dashboard, and orchestration — it talks to the coordinator via its REST admin API.

Each tenant gets its own subdomain (`<slug>.<base-domain>`), routed through Caddy. See `docs/adr/` for the reasoning behind each architectural choice (24 ADRs).

## Quick start

### Prerequisites

- Docker and Docker Compose
- Node.js 22+
- A running Docker daemon (Headscale instances are Docker containers)

### Setup

```sh
git clone https://github.com/DaveForan/atproto-tailnet.git
cd atproto-tailnet
cp .env.example .env          # defaults work for local dev
docker compose up -d          # PostgreSQL + Caddy
npm install                   # install dependencies
npm run db:migrate            # apply database migrations
npm run dev                   # http://127.0.0.1:3000 (reads .env)
```

Open `http://127.0.0.1:3000` and sign in with your Bluesky handle. Use the IP, not `localhost` — AT Proto OAuth redirects loopback clients to it.

### Coordinator mode (recommended)

```sh
# Rust coordinator + Postgres + Caddy in Docker; TS service on host
docker compose -f docker-compose.coordinator.dev.yml up -d
# Add to .env: COORDINATOR_URL=http://localhost:9443  COORDINATOR_API_KEY=dev-coordinator-key
npm run dev
```

Devices connect via `tailscale up --login-server http://<slug>.ts.localhost:8180`.

### Legacy Headscale mode

Each tailnet's Headscale is served through Caddy at `http://<slug>.ts.localhost:8180`. Two things to know when connecting a device locally:

- It only works from the same machine (`*.localhost` resolves to loopback).
- The URL is plain HTTP. After a dropped connection the Tailscale client retries over HTTPS on port 443, which nothing local answers, so a device can stay offline after Caddy or the tailnet restarts. Restart `tailscaled` on the device, or run it with `TS_FORCE_NOISE_443=false`. This does not apply to an HTTPS deployment.

> **Note:** If you have `NODE_ENV=production` set globally, use `npm install --include=dev` instead — the dev server and build tools are in devDependencies.

### Production build

```sh
npm run build                 # compiles to dist/
npm run start                 # runs dist/index.js
```

### Production deployment

For a real domain with wildcard TLS:

1. Point your domain's DNS to the server (A record for `tailnets.example.com`, wildcard `*.ts.example.com`)
2. Edit the two domain names in `Caddyfile.production` (used by `docker-compose.production.yml`)
3. Set `PUBLIC_URL`, `BASE_DOMAIN`, and `SESSION_SECRET` in `.env`; leave `TENANT_PUBLIC_PORT` unset
4. Caddy auto-provisions TLS via Let's Encrypt. The wildcard certificate needs a DNS challenge; `Caddyfile.production` does it through Cloudflare (`CF_API_TOKEN`), using the Caddy build in `Dockerfile.caddy`. For another DNS provider, swap the module in both files.

Tenant routes are not written in the Caddyfile: the service keeps one managed route in Caddy (through its admin API) in sync with the database, and re-adds it if Caddy restarts.

### Environment variables

See `.env.example` for all options. The defaults work for local development. For production you'll need:

- `SESSION_SECRET` — strong random string (32+ chars)
- `PUBLIC_URL` — your public-facing URL (e.g. `https://tailnets.example.com`)
- `BASE_DOMAIN` — wildcard domain for tenant subdomains (e.g. `ts.example.com`)
- `ATPROTO_PRIVATE_KEY` — ES256 JWK for AT Proto OAuth client auth
- `LOG_LEVEL` — `debug`, `info` (default), `warn`, or `error`

### npm scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start dev server with hot reload (tsx) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start` | Run compiled production server |
| `npm run db:generate` | Generate new migration from schema changes |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:studio` | Open Drizzle Studio (DB browser) |

## Project structure

```
coordinator/              — Rust mesh coordinator (ADR-0023)
  crates/
    coord-core/           — Shared types (TenantId, NodeId, etc.) and errors
    coord-noise/          — Noise IK handshake + encrypted transport
    coord-proto/          — Tailscale control protocol messages
    coord-acl/            — ACL policy engine
    coord-store/          — MemoryStore + PgStore (node/tenant CRUD)
    coord-netmap/         — Network map snapshot + delta builder
    coord-federation/     — Federation protocol, broker, inbound handlers (92 tests)
    coord-api/            — axum REST API + admin auth (42 tests)
    coord-server/         — Binary entrypoint

src/                      — TypeScript service layer
  auth/atproto.ts         — AT Proto OAuth setup
  config.ts               — Zod-validated env config
  db/schema.ts            — Drizzle schema (15 tables)
  orchestrator/
    headscale.ts          — Docker lifecycle management
    headscale-api.ts      — Headscale REST client
    control-client.ts     — ControlClient factory (coordinator or Headscale)
    caddy.ts              — Caddy admin API
    federation-broker.ts  — Federation broker loop + collective DID lifecycle
    monitor.ts            — Health check loop + auto-restart
  routes/                 — Express routes (auth, devices, federation, dashboard, etc.)
  identity/               — Collective DID management + resolver
  credentials/            — VC-JWT issuance/verification + AT Proto service-auth
  federation/             — CFP message signing, transport, handshake types
docs/adr/                 — Architecture Decision Records (0001–0024)
```

## Security model

The permission system has 16 discrete permissions assigned via custom roles:

`invite` · `kick` · `manage_roles` · `manage_settings` · `approve_devices` · `approve_joins` · `approve_services` · `lock_devices` · `view_audit_log` · `manage_devices` · `manage_services` · `manage_board` · `create_posts` · `create_agent_tokens` · `manage_agent_tokens` · `manage_acl`

The tenant originator has all permissions implicitly and cannot be kicked or demoted. Lockdown mode freezes all external access. Agent tokens are scoped to a single tenant with a permission subset and mandatory expiry.

See [ADR-0005](docs/adr/0005-security-management.md) for the full security design.

## Status

The TypeScript service layer is feature-complete (auth, networking, invitations, security management, services/board/agents, ACL, health monitoring, federation, usage metering, structured logging).

The Rust coordinator (ADR-0023) is feature-complete: Noise IK protocol, multi-tenant store (Memory + PostgreSQL), admin REST API, federation broker with signed handshakes, CIDR route exchange, replay protection, rate limiting, sub-collective hierarchy, and coordinator mode integration with the TS service. 201 Rust tests across the workspace (clippy clean). Security-hardened: constant-time auth, SSRF defense, error masking, signature verification on all federation endpoints.

See `BUILD_PLAN.md` for the full roadmap.

## License

Source-available. You may use and run this software freely. Redistribution requires permission. See [LICENSE](LICENSE).
