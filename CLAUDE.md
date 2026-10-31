# atproto-tailnet

Tailscale-as-a-service where users authenticate with their AT Protocol (Bluesky) identity, receive isolated tailnets, and invite others by handle.

## Architecture

- **Service API**: TypeScript / Express 5 / Drizzle ORM / PostgreSQL
- **Control plane**: One Headscale Docker container per tenant (see ADR-0002)
- **Auth**: AT Protocol OAuth via `@atproto/oauth-client-node` (see ADR-0003)
- **Reverse proxy**: Caddy with admin API for dynamic subdomain routing
- **Security model**: Composable role-based permissions, device approval, lockdown (see ADR-0005)
- **ADRs**: `docs/adr/0001-0005` — read these before changing architecture

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
- `hasPermission(membership, role, permission, req)` — originators always pass, others check role's JSONB permissions array; `req` param is required to enforce agent token scope intersection (omitting it would bypass token scoping)
- `Permission` type and `ALL_PERMISSIONS` constant live in `routes/permissions.ts`
- Two system roles per tenant: "originator" (all perms) and "citizen" (default for new members, customizable)
- `membership.isOriginator` is the hard source of truth for originator identity (overrides role)
- `isLockedDown(tenant)` — blocks invitations, acceptances, auth key generation, and agent token creation when true
- `toHsUsername(handle)` / `tenantLoginServer(slug)` — shared helpers in `routes/helpers.ts`
- `logAudit(...)` in `routes/audit.ts` — fire-and-forget append to `audit_logs` table
- Originator protection: `isOriginator` membership can never be deleted or role-changed (hard 403 in route)
- Tenant provisioning is async (setImmediate) — dashboard polls until status flips from "provisioning" to "running"
- Headscale bootstrap via `docker exec` (API key + initial user), all runtime operations via REST `HeadscaleApiClient`
- Dashboard HTML-escapes all user-controlled data via `esc()` and validates avatar URLs via `safeUrl()`
- Session cookie uses `sameSite: "lax"` for CSRF protection
- AT Proto handle validation: `HANDLE_RE` regex rejects non-handle input before any HTTP/DNS resolution
- Handle resolution: DNS TXT → HTTP .well-known → Bluesky public API
- Auth state/session stores are DB-backed (`oauth_states`, `oauth_sessions` tables via Drizzle upsert)
- Express sessions stored in PostgreSQL via `connect-pg-simple`
- Rate limiting: auth + `.well-known` routes 10 req/min, API routes 60 req/min (`express-rate-limit`)
- `.well-known/atproto-client-metadata.json` and `.well-known/jwks.json` served for production AT Proto OAuth
- Port allocation retries on unique constraint violation (PG error 23505) up to 3 times
- Port range 10001-10100 allocated from DB; excludes all non-deleted tenants
- All config flows through Zod-validated `src/config.ts` (including caddyAdminUrl, databaseUrl, atprotoPrivateKey)
- Device approval: when `requireDeviceApproval` is true, auth-key requests create pending `device_approvals`; owner approves to generate key
- Device locks: `device_locks` table binds a membership to specific Headscale `machineKey` values — blocks new key generation until unlocked
- Join requests: `allowJoinRequests` toggle + public `/join/:slug` page; gated by `approve_joins` permission; lockdown blocks requests
- Post-login redirect: `req.session.postLoginRedirect` stores destination (validated as local path) through OAuth flow
- Service devices: distinct from regular devices; `requireServiceDeviceApproval` toggle; originators auto-approve; gated by `manage_services` and `approve_services`
- Services: registered on approved service devices; `requireServiceApproval` toggle; must be active to appear on board
- Board posts: public message board at `/board/:slug`; `boardEnabled` toggle; `maxBoardPosts`/`maxBoardPostsDisplayed` limits; linked to active services
- Agent tokens: `at_`-prefixed Bearer tokens for AI agents; SHA-256 hashed storage; scoped to single tenant + permission subset; mandatory expiry (max 365 days)
- Agent middleware chain: `resolveAgentToken` (Bearer → hash lookup + tenant toggle check → req.agentToken) → `enforceAgentScope` (tenant UUID match + non-tenant route allowlist) → `requireAuth` → route handlers
- Agent token settings: `allowAgentTokens` master toggle, `allowMemberAgentTokens` member toggle; checked at token resolution time (not just creation)
- Agent auth helpers: `authUserId(req)` returns user ID from session or token; `authUserDid(req)` resolves DID (session or DB lookup). All route files use these instead of `req.session.userId` directly
- Agent scope enforcement: `enforceAgentScope` allows `/api/me`, `/api/permissions`, `/api/tenants`, `/health` without tenant UUID; all other non-tenant routes blocked
- Non-member responses: always 404 "Tenant not found" (never 403 — avoids leaking tenant existence)
- Guard clause ordering: param extraction → getTenantForUser → hasPermission → lockdown check → body validation → business logic
- List queries capped at `.limit(200)` with explicit `.orderBy()`
- Tenant lifecycle (delete/start/stop) audit-logged as `tenant_deleted`/`tenant_started`/`tenant_stopped`
- 16 permissions total: invite, kick, manage_roles, manage_settings, approve_devices, approve_joins, approve_services, lock_devices, view_audit_log, manage_devices, manage_services, manage_board, create_posts, create_agent_tokens, manage_agent_tokens, manage_acl
- ACL management: `GET/PUT /api/tenants/:id/acl` — fetch/push Headscale ACL policy (groups, hosts, tagOwners, autoApprovers); gated by `manage_acl`; Zod-validated before push
- Health monitoring: background 60s interval (`orchestrator/monitor.ts`) probes all running tenants via Headscale REST, auto-restarts failed containers, marks "error" if restart fails
- Per-tenant health endpoint: `GET /api/tenants/:id/health` — any member, returns live Headscale probe result
- Structured logging: `pino` via `src/logger.ts`; `LOG_LEVEL` env var (default: info); replaces all console.log/error

## File layout

```
src/
  types/express.d.ts       — Augments Express Request with agentToken context
  types/express-session.d.ts — Session data types (userId, did, postLoginRedirect)
  auth/atproto.ts          — AT Proto OAuth client setup + DB-backed stores
  config.ts                — Zod-validated env config
  db/schema.ts             — Drizzle schema (users, tenants, roles, memberships, invitations, device_approvals, device_locks, join_requests, service_devices, services, board_posts, agent_tokens, audit_logs)
  db/index.ts              — Database connection + pool export
  logger.ts                — Pino structured logger (LOG_LEVEL env)
  orchestrator/
    headscale.ts           — Docker lifecycle (create/start/stop/destroy), CLI exec
    headscale-api.ts       — REST client for running Headscale instances (includes getPolicy/setPolicy)
    caddy.ts               — Caddy admin API (dynamic route add/remove)
    ports.ts               — Port allocator
    monitor.ts             — Background health-check loop + per-tenant health probe
  routes/
    auth.ts                — /auth/login, /auth/callback, /auth/logout, /.well-known/* + tenant provisioning
    api.ts                 — /api/me, /api/tenants, /health, public tenant lookup, join request submit/status
    invitations.ts         — Create/accept/decline/revoke invitations (permission-gated)
    devices.ts             — Node listing, auth key generation, member management (permission-gated)
    permissions.ts         — ALL_PERMISSIONS constant, Permission type, role defaults
    security.ts            — Tenant settings, role CRUD, role assignment, device approvals/locks, join request management, audit log
    services.ts            — Service device registration/approval, service CRUD/approval
    board.ts               — Board posts CRUD, public board API + /board/:slug page
    agents.ts              — Agent token CRUD (create, list, revoke)
    acl.ts                 — ACL policy GET/PUT (manage_acl permission, Zod-validated)
    dashboard.ts           — Inline SPA (tabbed: Devices, Members, Invite, Add Device, Services, Board, Agents, ACL, Roles, Security, Audit) + /join/:slug
    helpers.ts             — Shared middleware, param(), permission checks, agent token resolution, hs username/URL helpers
    audit.ts               — Fire-and-forget audit log writer
docs/adr/                  — Architecture Decision Records (0001-0005)
BUILD_PLAN.md              — Phased build tracker
```
