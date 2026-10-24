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
- `getTenantForUser(tenantId, userId)` in `routes/helpers.ts` — shared membership+tenant lookup for all protected routes
- `tenantLoginServer(slug)` in api.ts/devices.ts — generates proper `<proto>://<slug>.<baseDomain>` URL
- Tenant provisioning is async (setImmediate) — dashboard polls until status flips from "provisioning" to "running"
- Headscale bootstrap via `docker exec` (API key + initial user), all runtime operations via REST `HeadscaleApiClient`
- Dashboard HTML-escapes all user-controlled data via `esc()` and validates avatar URLs via `safeUrl()`
- Session cookie uses `sameSite: "lax"` for CSRF protection
- AT Proto handle validation: `HANDLE_RE` regex rejects non-handle input before any HTTP/DNS resolution
- Handle resolution: DNS TXT → HTTP .well-known → Bluesky public API
- Auth state/session stores are DB-backed (`oauth_states`, `oauth_sessions` tables via Drizzle upsert)
- Express sessions stored in PostgreSQL via `connect-pg-simple`
- Rate limiting: auth routes 10 req/min, API routes 60 req/min (`express-rate-limit`)
- `.well-known/atproto-client-metadata.json` and `.well-known/jwks.json` served for production AT Proto OAuth
- Port allocation retries on unique constraint violation (PG error 23505) up to 3 times
- Port range 10001-10100 allocated from DB; excludes all non-deleted tenants
- All config flows through Zod-validated `src/config.ts` (including caddyAdminUrl, databaseUrl)

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
