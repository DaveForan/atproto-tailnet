# atproto-tailnet

Run private [Tailscale](https://tailscale.com)-compatible mesh networks (tailnets) with Bluesky identity. People sign in with their AT Protocol handle. There are no passwords. An instance is invite-only: the operators decide who gets a tailnet, and tailnet admins invite people by handle or DID.

The platform has a purpose-built Rust mesh coordinator (which replaces [Headscale](https://github.com/juanfont/headscale)). A TypeScript service layer handles authentication, orchestration, and the dashboard.

## How it works

1. **Set the operators.** Put your DID in `OPERATOR_DIDS`. Then sign in first.
2. **Get a tailnet.** Operators get a tailnet at sign-in. Operators can also designate "tailnet creators".
3. **Connect devices** with the standard `tailscale up --login-server <your-url>`.
4. **Invite people** by handle or DID. Copy the `/invite/<id>` link and send it. The service sends nothing by itself.
5. **Let people ask.** A person without access sees their invitations, and can request to join the default tailnet.
6. **Manage access** with roles, device approval, limits, and lockdown mode, in the dashboard or from Claude.

## Features

- **AT Protocol auth** — no passwords and no accounts to create. Your Bluesky DID is your identity.
- **Instance operators** — `OPERATOR_DIDS` controls who gets a tailnet. Optional single-tailnet mode. The **Instance** tab lists tailnets and users, and can suspend tailnets (with their sub-tailnets), delete tailnets, disable users, and show the activity log.
- **Invitations as the allow-list** — invite by handle or DID, then share the copyable link.
- **Join requests** — on the public `/join/<slug>` page, and for the default tailnet. Limits: 50 pending for each tailnet, one pending for each person, 24-hour cooldown after a rejection.
- **Remote MCP server** — connect Claude as a custom connector at `https://<APP_DOMAIN>/mcp`. OAuth with Bluesky sign-in. Operator tools are an opt-in. See [docs/site/guides/mcp.md](docs/site/guides/mcp.md).
- **Isolated networks** — each tenant has its own subdomain, with its own ACL, DERP map, and IP ranges
- **Role-based access** — 17 granular permissions, custom roles, originator protection
- **Device approval and notifications** — optional approval for new devices, a notification bell, and an optional signed webhook
- **Auth keys** — list and revoke keys. Removing a member also removes their devices and keys.
- **Device and member limits** — the originator sets them, and the service enforces them. There are no plans.
- **Device locking** — bind members to specified machines
- **Lockdown mode** — emergency freeze of all joins, invitations, and new devices
- **Service registry and public board** — register services and publish them at `/board/<slug>`
- **ACL management** — editor for access control rules (coordinator mode supports IP, CIDR and host rules)
- **Custom DERP relays** — relay regions for each tenant
- **Exit nodes and subnet routers** — approve and withdraw advertised routes
- **Usage metering** — live counts and 7-day history
- **Agent API tokens** — scoped Bearer tokens for automation
- **Health monitoring, hibernation, structured logging, full audit log**
- **Federation (off by default)** — the code for links between networks exists. It stays off because its data plane needs Docker and cross-instance traffic is not implemented.

## Architecture

| Layer | Technology |
|-------|-----------|
| Coordinator | Rust (9-crate workspace: coord-core, coord-noise, coord-proto, coord-acl, coord-store, coord-netmap, coord-federation, coord-api, coord-server) |
| Service layer | TypeScript / Express 5 / Drizzle ORM |
| Dashboard | React 19 / esbuild / lazy-loaded tabs / typed service layer |
| Database | PostgreSQL (service layer) or SQLite (coordinator standalone) |
| Auth | `@atproto/oauth-client-node` |
| Control plane | Rust coordinator (Noise IK protocol, multi-tenant) or Headscale (legacy, one Docker container for each tenant) |
| MCP | Remote MCP server (`/mcp`) with its own OAuth authorization server |
| Federation | Collective Federation Protocol (CFP). Off by default |
| Reverse proxy | Caddy (dynamic subdomains through the admin API) |

The coordinator speaks the Tailscale control protocol (Noise IK handshake, register/map over HTTP/2). It adds native multi-tenancy and sub-collective hierarchy. The coordinator can run standalone with SQLite (no external dependencies) or share PostgreSQL with the TypeScript service. The TypeScript service handles AT Proto OAuth, the dashboard, and orchestration. It talks to the coordinator through the REST admin API of the coordinator.

Each tenant has its own subdomain (`<slug>.<base-domain>`). Caddy routes the subdomain. In coordinator mode, a tenant subdomain serves only `/key`, `/ts2021` and `/health`.

## Quick start

### Prerequisites

- Docker and Docker Compose
- Node.js 22+

### Setup

```sh
git clone https://github.com/DaveForan/atproto-tailnet.git
cd atproto-tailnet
cp .env.example .env          # then set OPERATOR_DIDS=<your DID> in .env
docker compose up -d          # PostgreSQL + Caddy
npm install                   # install dependencies
npm run build:client          # build the React dashboard
npm run db:migrate            # apply database migrations
npm run dev                   # http://127.0.0.1:3000 (reads .env)
```

Open `http://127.0.0.1:3000` and sign in with your Bluesky handle. Use the IP address, not `localhost`, because AT Proto OAuth redirects loopback clients to the IP address.

Only operators get a tailnet. Put your own DID in `OPERATOR_DIDS` before you sign in. To find your DID, run `curl "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=you.bsky.social"`.

### Coordinator mode (recommended)

```sh
# Rust coordinator + Postgres + Caddy in Docker; TS service on host
docker compose -f docker-compose.coordinator.dev.yml up -d
# Add to .env: COORDINATOR_URL=http://localhost:9443  COORDINATOR_API_KEY=dev-coordinator-key-local-only-0000000000
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

For a real domain with wildcard TLS, follow [First deployment on DigitalOcean](docs/deployment.md#first-deployment-on-digitalocean) and [Droplet hardening](docs/deployment.md#droplet-hardening). In short:

1. Point the DNS of your domain to the server (A record for `tailnets.example.com`, wildcard `*.ts.example.com`).
2. Run `deploy/digitalocean/droplet-setup.sh`. It generates the secrets.
3. Set `PUBLIC_URL`, `APP_DOMAIN`, `BASE_DOMAIN`, `OPERATOR_DIDS` and `ATPROTO_PRIVATE_KEY` in `.env`. Leave `TENANT_PUBLIC_PORT` unset.
4. Choose a TLS strategy. Set `TLS_STRATEGY` in `.env` (default: `on-demand`). Each strategy is a directory in `caddy/tls-strategies/`. DNS-01 strategies also need `CADDY_DNS_PLUGINS`, so that the Caddy image builds with the provider module.
5. Start `docker compose -f docker-compose.coordinator.yml up -d`, then sign in as the operator first.
6. Use the cloud firewall of your provider. Docker-published ports bypass `ufw`.

The Caddyfile does not contain tenant routes. The service keeps one managed route in Caddy (through the admin API of Caddy) and synchronizes it with the database. The service adds the route again if Caddy restarts.

### Environment variables

See `.env.example` for all options. The defaults work for local development. For production, you need these variables:

- `OPERATOR_DIDS` — comma-separated DIDs of the instance operators
- `SESSION_SECRET` — strong random string (32+ chars). The app refuses weak or placeholder values
- `PUBLIC_URL` — your public URL (for example `https://tailnets.example.com`)
- `APP_DOMAIN` — the host of `PUBLIC_URL`, for Caddy
- `BASE_DOMAIN` — wildcard domain for tenant subdomains (for example `ts.example.com`)
- `ATPROTO_PRIVATE_KEY` — ES256 JWK for AT Proto OAuth client auth
- `TRUST_PROXY` — `1` behind Caddy (the compose files set it). Sign-in fails without it
- `LOG_LEVEL` — `debug`, `info` (default), `warn`, or `error`

For all variables, see the [configuration reference](docs/site/reference/configuration.md).

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
    coord-federation/     — Federation protocol, broker, inbound handlers, PgStore + SqliteStore (off by default)
    coord-api/            — axum REST API + admin auth (42 tests)
    coord-server/         — Binary entrypoint

src/                      — TypeScript service layer
  client/                 — React 19 dashboard SPA (esbuild)
    main.tsx              — Dashboard entry point
    join.tsx              — Join page entry point
    App.tsx               — Root component, lazy-loaded tab routing
    components/           — Shared UI (Badge, Card, EmptyState, Layout, Toast, Toggle)
    hooks/                — useAppState (global context), useTenantData, useMutation
    services/             — 20 typed API modules (one per domain)
    tabs/                 — 22 lazy-loaded tab components
    lib/                  — Types, constants, utilities
  auth/atproto.ts         — AT Proto OAuth setup
  config.ts               — Zod-validated env config
  db/schema.ts            — Drizzle schema (30 tables)
  orchestrator/
    headscale.ts          — Docker lifecycle management
    headscale-api.ts      — Headscale REST client
    control-client.ts     — ControlClient factory (coordinator or Headscale)
    caddy.ts              — Caddy admin API
    federation-broker.ts  — Federation broker loop + collective DID lifecycle
    monitor.ts            — Health check loop + auto-restart
  routes/                 — Express routes (auth, API, operator, notifications, dashboard HTML shell, etc.)
  operator/               — Instance policy: operators, tailnet creators, suspension, disabled users
  oauth/                  — OAuth authorization server for the MCP endpoint
  mcp/                    — Remote MCP server (/mcp) and its tools
  notifications/          — Notification rows and signed webhooks
  identity/               — Collective DID management + resolver
  credentials/            — VC-JWT issuance/verification + AT Proto service-auth
  federation/             — CFP message signing, transport, handshake types
esbuild.config.ts         — Client build config (two entry points: dashboard + join)
public/                   — Built client assets (JS bundles, CSS)
docs/adr/                 — Architecture Decision Records
```

## Security model

Instance operators come from `OPERATOR_DIDS`. They are the only users with instance powers (see [ADR-0025](docs/adr/0025-instance-operators-and-mcp-access.md)).

Inside a tenant, the permission system has 17 discrete permissions. You assign the permissions through custom roles:

`invite` · `kick` · `manage_roles` · `manage_settings` · `approve_devices` · `approve_joins` · `approve_services` · `lock_devices` · `view_audit_log` · `manage_devices` · `manage_services` · `manage_board` · `create_posts` · `create_agent_tokens` · `manage_agent_tokens` · `manage_acl` · `manage_sub_collectives`

The tenant originator has all permissions implicitly. Nobody can kick or demote the originator. Lockdown mode freezes all external access. An agent token applies to a single tenant, has a subset of permissions, and must have an expiry. An MCP token acts as the user, works only through the `/mcp` tools, and gets operator tools only with an explicit opt-in.

## Status

The TypeScript service layer includes these items:

- AT Proto auth, instance operators, and invite-only access
- Invitations, join requests, roles, device approval, notifications, limits, and lockdown
- Services, board, agent tokens, ACL, DERP, routes, and health monitoring
- The remote MCP server with OAuth
- A React 19 dashboard with 22 lazy-loaded tabs

The Rust coordinator includes these items:

- Noise IK protocol and a persistent control key
- Multi-tenant store (Memory, PostgreSQL, or SQLite)
- Admin REST API with per-tenant DERP, route approval, auto-approvers, and suspension
- Sub-collective hierarchy
- Coordinator mode integration with the TS service

Federation code exists in both layers, but it is off by default (`FEDERATION_ENABLED`, `COORD_FEDERATION_ENABLED`). Links carry no traffic in the coordinator stack yet.

## License

Source-available. You can use and run this software freely. Redistribution requires permission. See [LICENSE](LICENSE).
