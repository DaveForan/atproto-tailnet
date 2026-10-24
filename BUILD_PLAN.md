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
- [x] Remove member (owner only, with Headscale node/user cleanup)
- [x] Roles: owner, member (owner can manage, member can connect devices)

**Milestone:** Alice invites `@bob.bsky.social` → Bob logs in → sees invitation → accepts → gets connection instructions → Bob's devices can reach Alice's devices.

---

### 3.4 Security hardening (audit fixes)
- [x] XSS: HTML-escape all user-controlled data in dashboard (esc/safeUrl)
- [x] SSRF: Validate AT Protocol handle format before HTTP resolution
- [x] Headscale ports bound to 127.0.0.1 (not 0.0.0.0)
- [x] CSRF: SameSite=Lax on session cookie
- [x] IDOR: Membership check on tenant invitations endpoint
- [x] Session secret validation in production
- [x] Internal port removed from API responses
- [x] Login server URL uses proper domain (not localhost:port)
- [x] DNS TXT handle resolution (AT Proto ADR-0003 compliance)
- [x] Headscale operations consolidated on REST API (CLI exec only for bootstrap)
- [x] Dead code removed (ensureCaddyBaseConfig), caddy/db config centralized
- [x] Tenant deletion flow: destroy container + remove Caddy route + mark deleted
- [x] Tenant start/stop API endpoints
- [x] Health check endpoint (GET /health)
- [x] Slug collision handling (generateUniqueSlug)
- [x] Dashboard network error handling (try/catch on fetch)
- [x] Shared getTenantForUser helper (eliminates duplicate lookup logic)

## Phase 5: Security Management — "Control your network" (ADR-0005)

### 5.1 Composable role system
- [x] `roles` table with JSONB permissions, `isSystem` flag, unique (tenantId, name)
- [x] `memberships.isOriginator` boolean for hard originator protection
- [x] `memberships.roleId` FK to roles
- [x] `tenants.defaultRoleId` FK to roles (citizen by default)
- [x] 9 discrete permissions: invite, kick, manage_roles, manage_settings, approve_devices, approve_joins, lock_devices, view_audit_log, manage_devices
- [x] `hasPermission(membership, role, permission)` — originators always pass, others check role JSONB
- [x] Two system roles per tenant: originator (all perms, immutable) and citizen (customizable)
- [x] Role CRUD API (GET/POST/PATCH/DELETE /api/tenants/:id/roles)
- [x] Role assignment API (PUT /api/tenants/:id/members/:userId/role)
- [x] Default role API (PATCH /api/tenants/:id/default-role)
- [x] GET /api/permissions — list all available permissions
- [x] System role protection: originator role cannot be modified/deleted/assigned to non-originators
- [x] Originator membership can never be kicked or role-changed
- [x] Invitation acceptance assigns tenant's default role
- [x] Provisioning creates both system roles + sets citizen as default

### 5.2 Tenant security settings
- [x] `requireDeviceApproval` toggle — new devices need owner approval
- [x] `lockdownMode` toggle — blocks all invitations, joins, and device registrations
- [x] `PATCH /api/tenants/:id/settings` (owner only)
- [x] Lockdown banner on dashboard when active
- [x] Lockdown check on invitation create, accept, and auth-key generate

### 5.3 Device approval system
- [x] `device_approvals` table (pending/approved/rejected/expired)
- [x] Auth-key endpoint returns 202 + approval ID when approval required
- [x] `GET /api/tenants/:id/device-approvals` — list pending (owner/canInvite)
- [x] `POST .../approve` — generates Headscale pre-auth key on approval
- [x] `POST .../reject` — rejects request
- [x] `GET .../mine` — member views own approval status + key when approved
- [x] Lazy expiry: pending approvals auto-expire after 24h

### 5.4 Device locking
- [x] `device_locks` table — binds membership to specific Headscale machineKeys
- [x] `POST /api/tenants/:id/device-locks` — locks to current devices (self or owner)
- [x] `DELETE /api/tenants/:id/device-locks` — removes locks
- [x] `GET /api/tenants/:id/device-locks/:userId` — lists locked devices
- [x] Auth-key generation blocked when device locks exist

### 5.5 Audit log
- [x] `audit_logs` table — append-only, JSONB metadata
- [x] `logAudit()` fire-and-forget helper for all security-relevant actions
- [x] `GET /api/tenants/:id/audit-log` — paginated, owner-only
- [x] All permission changes, invitations, device operations, and settings mutations logged

### 5.6 Dashboard UI
- [x] Roles tab — role builder with permission chip toggles, create/delete roles, default role selector
- [x] Security tab (permission-gated) — settings toggles + pending device approval queue
- [x] Audit Log tab (permission-gated) — paginated event log with role action labels
- [x] Enhanced Members tab — role badge, role assignment dropdown for authorized users
- [x] Enhanced Devices tab — grouped by Headscale user
- [x] Add Device tab — handles pending_approval response
- [x] Lockdown banner with disable button
- [x] Tab visibility gated by permissions (not hard-coded to originator)

### 5.7 Join request system
- [x] `allowJoinRequests` toggle on tenant settings
- [x] `joinRequests` table (pending/approved/rejected, optional message)
- [x] `approve_joins` permission for gating who can review requests
- [x] Public tenant lookup (`GET /api/tenants/by-slug/:slug/public`) — minimal info, hidden in lockdown
- [x] Submit join request (`POST /api/tenants/:id/join-requests`) — deduplication, lockdown check, 500-char message limit
- [x] View own request status (`GET /api/tenants/:id/join-requests/mine`)
- [x] List/approve/reject requests in security management (`approve_joins` gated)
- [x] Approval creates Headscale user + membership with default role
- [x] Public `/join/:slug` page — sign-in via Bluesky, request form, status display
- [x] Post-login redirect preserves `/join/:slug` destination through OAuth flow
- [x] Shareable join link in settings when feature is enabled
- [x] Dashboard join request queue with approve/reject buttons
- [x] Audit logging for enable/disable/create/approve/reject actions

**Milestone:** Originator can create custom roles with arbitrary permission sets, assign roles to members, delegate role management, require device approval, lock devices, view audit trail, emergency-lockdown the tailnet, and open public join requests.

---

## Phase 4: Polish — "Production-ready"

### 4.1 ACL management
- [ ] UI for basic ACL rules (who can reach what)
- [ ] Push ACL updates to Headscale instance

### 4.2 Instance lifecycle
- [ ] Health checks and auto-restart
- [ ] Instance hibernation for inactive tenants (stop after N days idle, restart on connection)

### 4.3 Production deployment
- [ ] Real domain + wildcard TLS (Let's Encrypt via Caddy)
- [x] Client metadata hosted at `/.well-known/atproto-client-metadata.json`
- [x] JWKS endpoint for production OAuth (`/.well-known/jwks.json`)
- [x] Rate limiting (express-rate-limit: auth 10/min, API 60/min)
- [x] DB-backed auth state/session stores (oauth_states, oauth_sessions tables + connect-pg-simple)
- [x] Port race condition retry (catches PG 23505, retries up to 3 times)
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
