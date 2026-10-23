# atproto-tailnet

Tailscale-as-a-service where users authenticate with their AT Protocol (Bluesky) identity, receive isolated tailnets, and invite others by handle.

## Architecture

- **Service API**: TypeScript / Express 5 / Drizzle ORM / PostgreSQL
- **Control plane**: One Headscale Docker container per tenant (see ADR-0002)
- **Auth**: AT Protocol OAuth via `@atproto/oauth-client-node` (see ADR-0003)
- **Reverse proxy**: Caddy with admin API for dynamic subdomain routing
- **ADRs**: `docs/adr/0001-0004` — read these before changing architecture

## Development

```sh
# Prerequisites: Docker, Node.js 22+
cp .env.example .env
docker compose up -d             # PostgreSQL + Caddy
npm install --include=dev        # NODE_ENV=production is set globally on this box
npx drizzle-kit generate         # Generate migrations
npx drizzle-kit migrate          # Apply migrations
npm run dev                      # http://localhost:3000
```

## Key patterns

- `req.params` values are `string | string[]` in Express 5 — use `param(req, "name")` from `routes/helpers.ts`
- Tenant provisioning is async (setImmediate) — dashboard polls until status flips from "provisioning" to "running"
- Headscale API keys are created via `docker exec` after container start, not via config
- Auth state/session stores are in-memory Maps (dev); swap to DB-backed for production
- Port range 10001-10100 allocated from DB; excludes all non-deleted tenants

## File layout

```
src/
  auth/atproto.ts          — AT Proto OAuth client setup
  config.ts                — Zod-validated env config
  db/schema.ts             — Drizzle schema (users, tenants, memberships, invitations)
  db/index.ts              — Database connection
  orchestrator/
    headscale.ts           — Docker lifecycle (create/start/stop/destroy), CLI exec
    headscale-api.ts       — REST client for running Headscale instances
    caddy.ts               — Caddy admin API (dynamic route add/remove)
    ports.ts               — Port allocator
  routes/
    auth.ts                — /auth/login, /auth/callback, /auth/logout + tenant provisioning
    api.ts                 — /api/me, /api/tenants
    invitations.ts         — Create/accept/decline/revoke invitations by AT Proto handle
    devices.ts             — Node listing, auth key generation, member management
    dashboard.ts           — Inline SPA (dark theme, tabbed UI)
    helpers.ts             — Shared requireAuth middleware and param() helper
docs/adr/                  — Architecture Decision Records
BUILD_PLAN.md              — Phased build tracker
```
