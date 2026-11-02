# atproto-tailnet

Create private mesh networks using your Bluesky identity. Sign in with your AT Protocol handle, get an isolated [Tailscale](https://tailscale.com)-compatible network, and invite others by their `@handle`.

Built on [Headscale](https://github.com/juanfont/headscale) (open-source Tailscale control server) with one instance per tenant for full isolation.

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
- **Agent API tokens** — scoped Bearer tokens for AI agents and automation
- **Health monitoring** — background checks with auto-restart for failed instances
- **Instance hibernation** — auto-stop idle tenants after configurable days of inactivity
- **Structured logging** — Pino-based JSON logs with configurable level
- **Full audit log** — every security-relevant action recorded with metadata
- **Inline dashboard** — single-page app served from the backend, no separate frontend build

## Architecture

| Layer | Technology |
|-------|-----------|
| Language | TypeScript |
| API | Express 5 |
| Database | PostgreSQL |
| ORM | Drizzle |
| Auth | `@atproto/oauth-client-node` |
| Control plane | Headscale (one Docker container per tenant) |
| Reverse proxy | Caddy (dynamic subdomains via admin API) |

Each tenant gets a dedicated Headscale instance with its own subdomain (`<slug>.<base-domain>`), routed through Caddy. See `docs/adr/` for the reasoning behind each architectural choice.

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
npm run dev                   # http://localhost:3000
```

Open `http://localhost:3000` and sign in with your Bluesky handle.

> **Note:** If you have `NODE_ENV=production` set globally, use `npm install --include=dev` instead — the dev server and build tools are in devDependencies.

### Production build

```sh
npm run build                 # compiles to dist/
npm run start                 # runs dist/index.js
```

### Production deployment

For a real domain with wildcard TLS:

1. Point your domain's DNS to the server (A record for `tailnets.example.com`, wildcard `*.ts.example.com`)
2. Copy `Caddyfile.production` to `Caddyfile` and edit the domain names
3. Set `PUBLIC_URL`, `BASE_DOMAIN`, and `SESSION_SECRET` in `.env`
4. Caddy auto-provisions TLS via Let's Encrypt (uses DNS challenge for wildcard certs — requires a DNS provider API token, e.g. Cloudflare)

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
src/
  auth/atproto.ts         — AT Proto OAuth setup
  config.ts               — Zod-validated env config
  db/schema.ts            — Drizzle schema (15 tables)
  orchestrator/
    headscale.ts          — Docker lifecycle management
    headscale-api.ts      — Headscale REST client
    caddy.ts              — Caddy admin API
    ports.ts              — Port allocator
    monitor.ts            — Health check loop + auto-restart
  routes/
    auth.ts               — OAuth flow + .well-known endpoints
    api.ts                — Tenant CRUD, health, join requests
    invitations.ts        — Invite by handle, accept/decline
    devices.ts            — Node management, auth keys, members
    security.ts           — Settings, roles, approvals, locks, audit
    services.ts           — Service devices + service registry
    board.ts              — Public message board
    agents.ts             — Agent API token CRUD
    acl.ts                — ACL policy management
    dashboard.ts          — Inline SPA dashboard
    helpers.ts            — Shared middleware + auth helpers
    permissions.ts        — Permission definitions
    audit.ts              — Audit log writer
docs/adr/                 — Architecture Decision Records
```

## Security model

The permission system has 16 discrete permissions assigned via custom roles:

`invite` · `kick` · `manage_roles` · `manage_settings` · `approve_devices` · `approve_joins` · `approve_services` · `lock_devices` · `view_audit_log` · `manage_devices` · `manage_services` · `manage_board` · `create_posts` · `create_agent_tokens` · `manage_agent_tokens` · `manage_acl`

The tenant originator has all permissions implicitly and cannot be kicked or demoted. Lockdown mode freezes all external access. Agent tokens are scoped to a single tenant with a permission subset and mandatory expiry.

See [ADR-0005](docs/adr/0005-security-management.md) for the full security design.

## Status

This is an active development project. Phases 1-3 (auth, networking, invitations), Phase 5 (security management, services, board, agent tokens), and most of Phase 4 (ACL management, health monitoring, structured logging) are complete. Remaining Phase 4 items: instance hibernation and real UI design.

See `BUILD_PLAN.md` for the full roadmap.

## License

Source-available. You may use and run this software freely. Redistribution requires permission. See [LICENSE](LICENSE).
