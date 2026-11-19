# atproto-tailnet

Create private mesh networks with your Bluesky identity. Sign in with your AT Protocol handle and receive an isolated [Tailscale](https://tailscale.com)-compatible network. Invite others with their `@handle`.

The platform has a purpose-built Rust mesh coordinator (which replaces [Headscale](https://github.com/juanfont/headscale)). A TypeScript service layer handles authentication, orchestration, and the dashboard.

## How it works

1. **Sign in** with your Bluesky handle through AT Protocol OAuth
2. **Get a tailnet** — a private Headscale instance starts automatically
3. **Connect devices** — use the standard `tailscale up --login-server <your-url>` 
4. **Invite others** with their `@handle.bsky.social` — they sign in and join your network
5. **Manage access** — roles, permissions, device approval, lockdown mode

## Features

- **AT Protocol auth** — no passwords and no accounts to create. Your Bluesky DID is your identity.
- **Isolated networks** — each tenant has its own Headscale container, port, and subdomain
- **Role-based access** — 15 granular permissions, custom roles, originator protection
- **Device approval** — optional gate for new device connections
- **Device locking** — bind members to specified machines
- **Lockdown mode** — emergency freeze of all joins, invitations, and new devices
- **Service registry** — register services on your network and publish them to a public board
- **Public board** — the `/board/<slug>` page advertises services to the world
- **Join requests** — on the public `/join/<slug>` page, people can request access
- **ACL management** — visual editor for Headscale access control rules, groups, and hosts
- **Custom DERP relays** — relay regions for each tenant, embedded DERP server toggle, public relay control
- **IP range configuration** — IPv4/IPv6 CIDR prefixes and allocation strategy for each tenant
- **Exit nodes and subnet routers** — approve, enable, disable, and delete advertised routes
- **Usage metering** — live counts of devices, members, and routes, plan limits, and 7-day usage history snapshots
- **Federation** — request, accept, reject, and revoke trust links between collectives. Links use signed handshakes, CIDR route exchange, replay protection, and rate limiting.
- **Agent API tokens** — scoped Bearer tokens for AI agents and automation
- **Health monitoring** — background checks that restart failed instances automatically
- **Instance hibernation** — the system stops idle tenants automatically after a configurable number of days without activity
- **Structured logging** — Pino JSON logs with a configurable level
- **Full audit log** — the system records every security-relevant action with metadata
- **React 19 dashboard** — lazy-loaded SPA with a typed service layer, built with esbuild

## Architecture

| Layer | Technology |
|-------|-----------|
| Coordinator | Rust (8-crate workspace: coord-core, coord-noise, coord-proto, coord-acl, coord-store, coord-netmap, coord-federation, coord-api) |
| Service layer | TypeScript / Express 5 / Drizzle ORM |
| Dashboard | React 19 / esbuild / lazy-loaded tabs / typed service layer |
| Database | PostgreSQL (service layer) or SQLite (coordinator standalone) |
| Auth | `@atproto/oauth-client-node` |
| Control plane | Rust coordinator (Noise IK protocol, multi-tenant, federation) or Headscale (legacy, one Docker container for each tenant) |
| Federation | Collective Federation Protocol (CFP) — JSON over HTTP/2, DID-based identity, signed handshakes, CIDR route exchange |
| Reverse proxy | Caddy (dynamic subdomains through the admin API) |

The coordinator speaks the Tailscale control protocol (Noise IK handshake, register/map over HTTP/2). It adds native multi-tenancy, federation between collectives, and sub-collective hierarchy. The coordinator can run standalone with SQLite (no external dependencies) or share PostgreSQL with the TypeScript service. The TypeScript service handles AT Proto OAuth, the dashboard, and orchestration. It talks to the coordinator through the REST admin API of the coordinator.

Each tenant has its own subdomain (`<slug>.<base-domain>`). Caddy routes the subdomain.

## Quick start

### Prerequisites

- Docker and Docker Compose
- Node.js 22+
- A Docker daemon that runs (Headscale instances are Docker containers)

### Setup

```sh
git clone https://github.com/DaveForan/atproto-tailnet.git
cd atproto-tailnet
cp .env.example .env          # defaults work for local dev
docker compose up -d          # PostgreSQL + Caddy
npm install                   # install dependencies
npm run build:client          # build the React dashboard
npm run db:migrate            # apply database migrations
npm run dev                   # http://127.0.0.1:3000 (reads .env)
```

Open `http://127.0.0.1:3000` and sign in with your Bluesky handle. Use the IP address, not `localhost`, because AT Proto OAuth redirects loopback clients to the IP address.

### Coordinator mode (recommended)

```sh
# Rust coordinator + Postgres + Caddy in Docker; TS service on host
docker compose -f docker-compose.coordinator.dev.yml up -d
# Add to .env: COORDINATOR_URL=http://localhost:9443  COORDINATOR_API_KEY=dev-coordinator-key
npm run dev
```

Devices connect with `tailscale up --login-server http://<slug>.ts.localhost:8180`.

### Legacy Headscale mode

Caddy serves the Headscale instance of each tailnet at `http://<slug>.ts.localhost:8180`. Note these two limits when you connect a device locally:

- It works only from the same machine, because `*.localhost` resolves to loopback.
- The URL uses plain HTTP. After a dropped connection, the Tailscale client retries over HTTPS on port 443. Nothing local answers on that port. A device can stay offline after Caddy or the tailnet restarts. To fix this, restart `tailscaled` on the device, or start it with `TS_FORCE_NOISE_443=false`. This limit does not apply to an HTTPS deployment.

> **Note:** If you set `NODE_ENV=production` globally, use `npm install --include=dev` instead. The dev server and build tools are in devDependencies.

### Production build

```sh
npm run build:client          # builds dashboard JS/CSS to public/
npm run build                 # compiles server to dist/
npm run start                 # runs dist/index.js
```

### Production deployment

For a real domain with wildcard TLS:

1. Point the DNS of your domain to the server (A record for `tailnets.example.com`, wildcard `*.ts.example.com`)
2. Set `PUBLIC_URL`, `BASE_DOMAIN`, `APP_DOMAIN`, and `SESSION_SECRET` in `.env`. Leave `TENANT_PUBLIC_PORT` unset.
3. Choose a TLS strategy. Set `TLS_STRATEGY` in `.env` (default: `on-demand`). Each strategy is a directory in `caddy/tls-strategies/`. The files in the directory document the required env vars. DNS-01 strategies also need `CADDY_DNS_PLUGINS`, so that the Caddy image builds with the provider module.

The Caddyfile does not contain tenant routes. The service keeps one managed route in Caddy (through the admin API of Caddy) and synchronizes it with the database. The service adds the route again if Caddy restarts.

### Environment variables

See `.env.example` for all options. The defaults work for local development. For production, you need these variables:

- `SESSION_SECRET` — strong random string (32+ chars)
- `PUBLIC_URL` — your public URL (for example `https://tailnets.example.com`)
- `BASE_DOMAIN` — wildcard domain for tenant subdomains (for example `ts.example.com`)
- `ATPROTO_PRIVATE_KEY` — ES256 JWK for AT Proto OAuth client auth
- `LOG_LEVEL` — `debug`, `info` (default), `warn`, or `error`

### npm scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start dev server with hot reload (tsx) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start` | Run compiled production server |
| `npm run build:client` | Build React dashboard to `public/js/` |
| `npm run dev:client` | Watch-mode dashboard rebuild |
| `npm run db:generate` | Generate new migration from schema changes |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:studio` | Open Drizzle Studio (DB browser) |

## Project structure

```
coordinator/              — Rust mesh coordinator
  crates/
    coord-core/           — Shared types (TenantId, NodeId, etc.) and errors
    coord-noise/          — Noise IK handshake + encrypted transport
    coord-proto/          — Tailscale control protocol messages
    coord-acl/            — ACL policy engine
    coord-store/          — MemoryStore + PgStore + SqliteStore (node/tenant CRUD)
    coord-netmap/         — Network map snapshot + delta builder
    coord-federation/     — Federation protocol, broker, inbound handlers, PgStore + SqliteStore (94 tests)
    coord-api/            — axum REST API + admin auth (42 tests)
    coord-server/         — Binary entrypoint

src/                      — TypeScript service layer
  client/                 — React 19 dashboard SPA (esbuild)
    main.tsx              — Dashboard entry point
    join.tsx              — Join page entry point
    App.tsx               — Root component, lazy-loaded tab routing
    components/           — Shared UI (Badge, Card, EmptyState, Layout, Toast, Toggle)
    hooks/                — useAppState (global context), useTenantData, useMutation
    services/             — 16 typed API modules (one per domain)
    tabs/                 — 20 lazy-loaded tab components
    lib/                  — Types, constants, utilities
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
  routes/                 — Express routes (auth, API, dashboard HTML shell, etc.)
  identity/               — Collective DID management + resolver
  credentials/            — VC-JWT issuance/verification + AT Proto service-auth
  federation/             — CFP message signing, transport, handshake types
esbuild.config.ts         — Client build config (two entry points: dashboard + join)
public/                   — Built client assets (JS bundles, CSS)
docs/adr/                 — Architecture Decision Records
```

## Security model

The permission system has 16 discrete permissions. You assign the permissions through custom roles:

`invite` · `kick` · `manage_roles` · `manage_settings` · `approve_devices` · `approve_joins` · `approve_services` · `lock_devices` · `view_audit_log` · `manage_devices` · `manage_services` · `manage_board` · `create_posts` · `create_agent_tokens` · `manage_agent_tokens` · `manage_acl`

The tenant originator has all permissions implicitly. Nobody can kick or demote the originator. Lockdown mode freezes all external access. An agent token applies to a single tenant, has a subset of permissions, and must have an expiry.

## Status

The TypeScript service layer is feature-complete. It includes auth, networking, invitations, security management, services/board/agents, ACL, health monitoring, federation, usage metering, and structured logging. The dashboard is a React 19 SPA with 20 lazy-loaded tabs, a typed service layer (16 domain modules), and shared hooks for data loading and mutations.

The Rust coordinator is feature-complete. It includes these items:

- Noise IK protocol
- Multi-tenant store (Memory, PostgreSQL, or SQLite)
- Admin REST API
- Federation broker with signed handshakes, CIDR route exchange, replay protection, and rate limiting
- Sub-collective hierarchy
- Coordinator mode integration with the TS service

The coordinator fully implements all three storage backends (including federation persistence). The workspace has 210 tests. The coordinator has security hardening: constant-time auth, SSRF defense, error masking, and signature verification on all federation endpoints.

## License

Source-available. You can use and run this software freely. Redistribution requires permission. See [LICENSE](LICENSE).
