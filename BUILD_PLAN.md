# Build Plan — atproto-tailnet

> A service where users create Tailscale mesh networks via their AT Protocol identity
> and invite others by their Bluesky handle.

## Architecture decisions

See `docs/adr/` for rationale behind each choice:

- **ADR-0001**: Headscale as the control plane (only OSS Tailscale-compatible server)
- **ADR-0002**: One Headscale instance per tenant (not a fork — zero maintenance burden)
- **ADR-0003**: AT Protocol OAuth 2.0 for all authentication (DID as stable identity)
- **ADR-0004**: TypeScript service + Docker-managed Headscale instances + Caddy + PostgreSQL

---

## Phase 1: Foundation — "Login and see your empty tailnet"

**Goal:** User can sign in with their Bluesky handle and land on a dashboard showing their (empty) tailnet.

### 1.1 Project scaffold
- [x] Create project directory and ADR docs
- [x] Initialize TypeScript project (Express, Drizzle, pg)
- [x] Docker Compose: PostgreSQL, Caddy
- [x] Basic project config (env vars, tsconfig, build)

### 1.2 AT Proto OAuth
- [x] Install `@atproto/oauth-client-node`, `@atproto/api`
- [x] Generate ES256 key pair for client auth (production path ready)
- [x] Implement `/auth/login` — initiate AT Proto OAuth flow
- [x] Implement `/auth/callback` — handle OAuth redirect, extract DID + handle
- [x] Session management — HTTP-only cookie → server-side session
- [x] Dev mode: loopback client metadata for localhost
- [x] DB tables: `auth_state`, `auth_sessions` (in-memory stores for dev; DB-backed for prod)

### 1.3 User + tenant data model
- [x] DB tables: `users` (did, handle, display_name, avatar_url)
- [x] DB tables: `tenants` (id, slug, owner_user_id, port, status)
- [x] DB tables: `memberships` (user_id, tenant_id, role)
- [x] Auto-create tenant on first login (owner gets a tailnet)

### 1.4 Headscale orchestrator (MVP)
- [x] Headscale config template (YAML)
- [x] `createInstance(tenant)` — generate config, create Docker container, start it
- [x] `destroyInstance(tenant)` — stop and remove container
- [x] `getInstanceStatus(tenant)` — check if running
- [x] Port allocator — assign from range, store in DB
- [x] API key generation per instance (via CLI exec after startup)

### 1.5 Dashboard (minimal)
- [x] Serve inline SPA (server-rendered HTML with client-side JS)
- [x] Show: logged-in user handle + avatar
- [x] Show: tenant name, status (running/stopped)
- [x] Show: "Your login server URL" (`tailscale up --login-server ...`)
- [x] Show: connected nodes list

**Milestone:** `npm run dev` → open browser → "Sign in with Bluesky" → OAuth dance → see your tailnet dashboard with connection instructions.

---

## Phase 2: Networking — "Connect a device"

**Goal:** User can actually connect a Tailscale client to their tailnet.

### 2.1 Caddy dynamic routing
- [x] Wildcard DNS setup (configurable `BASE_DOMAIN`, default `ts.localhost`)
- [x] Caddy config: Caddyfile + admin API at :2019
- [x] Caddy admin API integration for dynamic upstream add/remove (`orchestrator/caddy.ts`)

### 2.2 Node registration flow
- [x] Generate pre-auth key via Headscale CLI exec when user clicks "Add device"
- [x] Display connection command: `tailscale up --login-server ... --authkey <key>`
- [x] Headscale REST API client for node list, show connected devices on dashboard

### 2.3 Device management
- [x] List nodes (name, IP, online status, user)
- [x] Remove node
- [x] Rename node (via Headscale API client)

**Milestone:** User logs in → clicks "Add device" → copies command → runs on their machine → device appears in dashboard → can ping other devices in the same tailnet.

---

## Phase 3: Invitations — "Add someone to your tailnet"

**Goal:** Tailnet owner can invite others by their Bluesky handle.

### 3.1 Invitation system
- [x] DB table: `invitations` (tenant_id, inviter_user_id, invitee_did, status)
- [x] Resolve handle → DID via AT Proto resolution (HTTP `.well-known` + Bluesky public API fallback)
- [x] API: `POST /tenants/:id/invitations` — create invitation
- [x] API: `GET /invitations` — list pending invitations for current user

### 3.2 Invitation acceptance flow
- [x] Show pending invitations in dashboard
- [x] Accept → create membership + Headscale user + pre-auth key
- [x] Decline → mark invitation as declined

### 3.3 Member management
- [x] List members of a tailnet
- [x] Remove member (owner only)
- [x] Roles: owner, member
- [ ] Roles: owner, member (owner can manage, member can connect devices)

**Milestone:** Alice invites `@bob.bsky.social` → Bob logs in → sees invitation → accepts → gets connection instructions → Bob's devices can reach Alice's devices.

---

## Phase 4: Polish — "Production-ready"

### 4.1 ACL management
- [ ] Default policy: all members can reach all devices (simple start)
- [ ] UI for basic ACL rules (who can reach what)
- [ ] Push ACL updates to Headscale instance

### 4.2 Instance lifecycle
- [ ] Graceful shutdown/restart of Headscale instances
- [ ] Health checks and auto-restart
- [ ] Instance hibernation for inactive tenants (stop after N days idle, restart on connection)

### 4.3 Production deployment
- [ ] Real domain + wildcard TLS (Let's Encrypt via Caddy)
- [ ] Client metadata hosted at `/.well-known/atproto-client-metadata.json`
- [ ] JWKS endpoint for production OAuth
- [ ] Rate limiting, CSRF protection
- [ ] Logging, error tracking

### 4.4 UX polish
- [ ] Real UI design (not just functional)
- [ ] Mobile-friendly
- [ ] Setup wizard for first-time users
- [ ] Network status / connectivity diagnostics

---

## Out of scope (for now)

- Custom DERP relays per tenant
- Per-tenant IP range configuration
- Exit nodes / subnet routers management UI
- Billing / usage metering
- Federation between tailnets
- Headscale fork for true single-process multi-tenancy (see ADR-0002 — escape hatch)

---

## Tech stack summary

| Layer | Technology |
|-------|-----------|
| Language | TypeScript |
| API framework | Express 5 |
| Database | PostgreSQL (service state) + SQLite (per-Headscale instance) |
| ORM | Drizzle |
| Auth | `@atproto/oauth-client-node` |
| Control plane | Headscale (Docker containers, one per tenant) |
| Reverse proxy | Caddy (wildcard TLS, dynamic upstreams) |
| Process management | Docker (dev), systemd or K8s (prod) |
| Frontend | TBD — React SPA or server-rendered (decide in Phase 1.5) |
