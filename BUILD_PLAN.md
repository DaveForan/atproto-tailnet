# Build Plan — atproto-tailnet

> A service where users create Tailscale mesh networks with their AT Protocol identity
> and invite others with their Bluesky handle.

## Architecture decisions

See `docs/adr/` for the reason for each choice:

- **ADR-0001**: Headscale as the control plane (the only open-source Tailscale-compatible server)
- **ADR-0002**: One Headscale instance for each tenant (not a fork — no maintenance burden)
- **ADR-0003**: AT Protocol OAuth 2.0 for all authentication (DID as the stable identity)
- **ADR-0004**: TypeScript service + Headscale instances in Docker + Caddy + PostgreSQL

---

## Phase 1: Foundation — "Login and see your empty tailnet"

**Goal:** The user signs in with their Bluesky handle and sees a dashboard that shows their (empty) tailnet.

### 1.1 Project scaffold
- [x] Create project directory and ADR docs
- [x] Initialize TypeScript project (Express, Drizzle, pg)
- [x] Docker Compose: PostgreSQL, Caddy
- [x] Basic project config (env vars, tsconfig, build)

### 1.2 AT Proto OAuth
- [x] Install `@atproto/oauth-client-node`, `@atproto/api`
- [x] Generate an ES256 key pair for client auth (production path ready)
- [x] Implement `/auth/login` — initiate AT Proto OAuth flow
- [x] Implement `/auth/callback` — handle the OAuth redirect, extract DID + handle
- [x] Session management — HTTP-only cookie → session on the server
- [x] Development mode: loopback client metadata for localhost
- [x] DB tables: `auth_state`, `auth_sessions` (in-memory stores for development; DB-backed stores for production)

### 1.3 User + tenant data model
- [x] DB tables: `users` (did, handle, display_name, avatar_url)
- [x] DB tables: `tenants` (id, slug, owner_user_id, port, status)
- [x] DB tables: `memberships` (user_id, tenant_id, role)
- [x] Create the tenant automatically at first login (the owner receives a tailnet)

### 1.4 Headscale orchestrator (MVP)
- [x] Headscale config template (YAML)
- [x] `createInstance(tenant)` — generate config, create Docker container, start it
- [x] `destroyInstance(tenant)` — stop and remove container
- [x] `getInstanceStatus(tenant)` — check if running
- [x] Port allocator — assign a port from the range, store it in the DB
- [x] API key generation for each instance (through CLI exec after startup)

### 1.5 Dashboard (minimal)
- [x] Serve the inline SPA (server-rendered HTML with client-side JS)
- [x] Show: logged-in user handle + avatar
- [x] Show: tenant name, status (running/stopped)
- [x] Show: "Your login server URL" (`tailscale up --login-server ...`)
- [x] Show: connected nodes list

**Milestone:** `npm run dev` → open the browser → "Sign in with Bluesky" → complete the OAuth flow → see your tailnet dashboard with connection instructions.

---

## Phase 2: Networking — "Connect a device"

**Goal:** The user connects a Tailscale client to their tailnet.

### 2.1 Caddy dynamic routing
- [x] Wildcard DNS setup (`BASE_DOMAIN` is configurable, default `ts.localhost`)
- [x] Caddy config: Caddyfile + admin API at :2019
- [x] Caddy admin API integration to add and remove upstreams dynamically (`orchestrator/caddy.ts`)

### 2.2 Node registration flow
- [x] Generate a pre-auth key with Headscale CLI exec when the user clicks "Add device"
- [x] Display connection command: `tailscale up --login-server ... --authkey <key>`
- [x] Headscale REST API client for the node list, show connected devices on the dashboard

### 2.3 Device management
- [x] List nodes (name, IP, online status, user)
- [x] Remove node
- [x] Rename node (through the Headscale API client)

**Milestone:** The user logs in → clicks "Add device" → copies the command → runs it on their machine → the device appears in the dashboard → the device can ping other devices in the same tailnet.

---

## Phase 3: Invitations — "Add someone to your tailnet"

**Goal:** The tailnet owner invites others with their Bluesky handle.

### 3.1 Invitation system
- [x] DB table: `invitations` (tenant_id, inviter_user_id, invitee_did, status)
- [x] Resolve handle → DID with AT Proto resolution (HTTP `.well-known` + Bluesky public API fallback)
- [x] API: `POST /tenants/:id/invitations` — create invitation
- [x] API: `GET /invitations` — list pending invitations for the current user

### 3.2 Invitation acceptance flow
- [x] Show pending invitations in the dashboard
- [x] Accept → create membership + Headscale user + pre-auth key
- [x] Decline → mark the invitation as declined

### 3.3 Member management
- [x] List members of a tailnet
- [x] Remove member (owner only, with Headscale node/user cleanup)
- [x] Roles: owner, member (owner can manage, member can connect devices)

**Milestone:** Alice invites `@bob.bsky.social` → Bob logs in → sees the invitation → accepts → receives connection instructions → Bob's devices can reach Alice's devices.

---

### 3.4 Security hardening (audit fixes)
- [x] XSS: HTML-escape all user-controlled data in the dashboard (esc/safeUrl)
- [x] SSRF: Validate AT Protocol handle format before HTTP resolution
- [x] Bind Headscale ports to 127.0.0.1 (not 0.0.0.0)
- [x] CSRF: SameSite=Lax on session cookie
- [x] IDOR: Membership check on tenant invitations endpoint
- [x] Session secret validation in production
- [x] Remove the internal port from API responses
- [x] The login server URL uses the correct domain (not localhost:port)
- [x] DNS TXT handle resolution (AT Proto ADR-0003 compliance)
- [x] Move Headscale operations to the REST API (CLI exec only for bootstrap)
- [x] Remove dead code (ensureCaddyBaseConfig), centralize the caddy/db config
- [x] Tenant deletion flow: destroy the container + remove the Caddy route + mark the tenant as deleted
- [x] Tenant start/stop API endpoints
- [x] Health check endpoint (GET /health)
- [x] Slug collision handling (generateUniqueSlug)
- [x] Network error handling in the dashboard (try/catch on fetch)
- [x] Shared getTenantForUser helper (removes duplicate lookup logic)

## Phase 5: Security Management — "Control your network" (ADR-0005)

### 5.1 Composable role system
- [x] `roles` table with JSONB permissions, `isSystem` flag, unique (tenantId, name)
- [x] `memberships.isOriginator` boolean for hard originator protection
- [x] `memberships.roleId` FK to roles
- [x] `tenants.defaultRoleId` FK to roles (citizen by default)
- [x] 16 discrete permissions: invite, kick, manage_roles, manage_settings, approve_devices, approve_joins, approve_services, lock_devices, view_audit_log, manage_devices, manage_services, manage_board, create_posts, create_agent_tokens, manage_agent_tokens, manage_acl
- [x] `hasPermission(membership, role, permission, req)` — originators always pass, others check role JSONB; req enforces agent token scope
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
- [x] `requireDeviceApproval` toggle — the owner must approve new devices
- [x] `lockdownMode` toggle — blocks all invitations, joins, and device registrations
- [x] `PATCH /api/tenants/:id/settings` (owner only)
- [x] Lockdown banner on dashboard when active
- [x] Lockdown check when the user creates or accepts an invitation and when the user generates an auth key

### 5.3 Device approval system
- [x] `device_approvals` table (pending/approved/rejected/expired)
- [x] Auth-key endpoint returns 202 + approval ID when approval required
- [x] `GET /api/tenants/:id/device-approvals` — list pending approvals (owner/canInvite)
- [x] `POST .../approve` — generates a Headscale pre-auth key on approval
- [x] `POST .../reject` — rejects request
- [x] `GET .../mine` — the member sees their own approval status + key when approved
- [x] Lazy expiry: pending approvals expire automatically after 24h

### 5.4 Device locking
- [x] `device_locks` table — binds a membership to specific Headscale machineKeys
- [x] `POST /api/tenants/:id/device-locks` — locks to current devices (self or owner)
- [x] `DELETE /api/tenants/:id/device-locks` — removes locks
- [x] `GET /api/tenants/:id/device-locks/:userId` — lists locked devices
- [x] The app blocks auth-key generation when device locks exist

### 5.5 Audit log
- [x] `audit_logs` table — append-only, JSONB metadata
- [x] `logAudit()` fire-and-forget helper for all security-relevant actions
- [x] `GET /api/tenants/:id/audit-log` — paginated, owner-only
- [x] The app logs all permission changes, invitations, device operations, and settings changes

### 5.6 Dashboard UI
- [x] Roles tab — role builder with permission chip toggles, create/delete roles, default role selector
- [x] Security tab (permission-gated) — settings toggles + pending device approval queue
- [x] Audit Log tab (permission-gated) — paginated event log with role action labels
- [x] Enhanced Members tab — role badge, role assignment dropdown for authorized users
- [x] Enhanced Devices tab — grouped by Headscale user
- [x] Add Device tab — handles the pending_approval response
- [x] Lockdown banner with disable button
- [x] Permissions control tab visibility (not hard-coded to originator)

### 5.7 Join request system
- [x] `allowJoinRequests` toggle on tenant settings
- [x] `joinRequests` table (pending/approved/rejected, optional message)
- [x] `approve_joins` permission for gating who can review requests
- [x] Public tenant lookup (`GET /api/tenants/by-slug/:slug/public`) — minimal info, hidden in lockdown
- [x] Submit join request (`POST /api/tenants/:id/join-requests`) — deduplication, lockdown check, 500-char message limit
- [x] View own request status (`GET /api/tenants/:id/join-requests/mine`)
- [x] List/approve/reject requests in security management (`approve_joins` gated)
- [x] Approval creates a Headscale user + a membership with the default role
- [x] Public `/join/:slug` page — sign-in via Bluesky, request form, status display
- [x] Post-login redirect keeps the `/join/:slug` destination through the OAuth flow
- [x] Shareable join link in settings when the feature is enabled
- [x] Dashboard join request queue with approve/reject buttons
- [x] Audit logging for enable/disable/create/approve/reject actions

**Milestone:** The originator can do these things: create custom roles with any permission set, assign roles to members, delegate role management, require device approval, lock devices, view the audit trail, lock down the tailnet in an emergency, and open public join requests.

### 5.8 Service devices and services
- [x] `service_devices` table with pending/approved/rejected status, auth key generation on approval
- [x] `services` table linked to approved service devices, with pending/active/disabled status
- [x] `requireServiceDeviceApproval` and `requireServiceApproval` tenant settings
- [x] 4 new permissions: `approve_services`, `manage_services`, `manage_board`, `create_posts`
- [x] Service device registration with optional approval workflow (originators approve automatically)
- [x] Service device approve/reject/remove endpoints
- [x] Service CRUD with optional approval workflow
- [x] Service approve/reject/remove endpoints
- [x] Dashboard Services tab with device and service management, registration forms, and approval actions
- [x] Lockdown blocks service device registration

### 5.9 Public message board
- [x] `board_posts` table linked to active services, with active/removed status
- [x] `boardEnabled`, `maxBoardPosts`, `maxBoardPostsDisplayed` tenant settings
- [x] Board post CRUD gated by `create_posts` (own posts) and `manage_board` (any post)
- [x] Post count enforced against `maxBoardPosts` limit
- [x] Public board API (`GET /api/tenants/by-slug/:slug/board`) — returns posts with service details, obeys the display limit
- [x] Public `/board/:slug` page — dark theme, shows post cards with service details that expand
- [x] The app hides the board in lockdown mode
- [x] Dashboard Board tab with post management, creation form linked to active services
- [x] Board settings (enable, limits) in Security tab
- [x] Shareable board link when enabled
- [x] Queue of pending service approvals in the Security tab
- [x] Audit logging for all board, service, and service device actions

### 5.10 Agent API tokens
- [x] `agent_tokens` table — SHA-256 hashed, `at_` prefix, scoped to single tenant + permission subset
- [x] `allowAgentTokens` master toggle, `allowMemberAgentTokens` member toggle on tenant settings
- [x] Token CRUD: create (POST), list (GET), revoke (DELETE) at `/api/tenants/:id/agent-tokens`
- [x] Middleware chain: `resolveAgentToken` → `enforceAgentScope` → route handlers
- [x] `authUserId(req)` / `authUserDid(req)` helpers — all route files use these instead of `req.session.userId`
- [x] Agent scope enforcement: tenant UUID match, non-tenant route allowlist
- [x] Enforce the token toggle at resolution time (not only at creation)
- [x] Privilege escalation prevention: token permissions intersect with the scope of the creator
- [x] Lockdown blocks token creation
- [x] Dashboard Agents tab with token creation, permission selection, revoke
- [x] Agent token settings toggles in Security settings

### 5.11 Consistency hardening
- [x] Standard 404 "Tenant not found" response for non-members (no leak of tenant existence)
- [x] Separate guard clauses: 404 (not a member) and 403 (insufficient permissions)
- [x] Standard `{ error, details }` format for Zod validation error responses
- [x] All list queries have `.limit(200)` and `.orderBy()`
- [x] The app writes audit logs for the tenant lifecycle (delete/start/stop)
- [x] Rate limits on `/.well-known/*` endpoints
- [x] `session.save()` error handling in OAuth callback
- [x] `ATPROTO_PRIVATE_KEY` goes through config.ts (centralized env config)
- [x] JSDoc on all modules and exports

**Milestone:** Agent tokens enable AI automation against tenant APIs with scoped permissions, mandatory expiry, and a full audit trail. All routes use the same guard order, error shapes, and response patterns.

---

## Phase 4: Polish — "Production-ready"

### 4.1 ACL management
- [x] ACL policy API: `GET/PUT /api/tenants/:id/acl` with Zod validation
- [x] Push validated policy to Headscale REST API (policy mode: database)
- [x] `manage_acl` permission (16th permission) gating ACL routes
- [x] Dashboard ACL tab: rules table (add/delete), groups editor, hosts editor, save/reset
- [x] The ACL policy fetches Headscale users for autocomplete in the UI
- [x] `acl_updated` audit action with rule/group count metadata

### 4.2 Instance lifecycle
- [x] Background health monitor (60s interval, `orchestrator/monitor.ts`)
- [x] Restart failed Headscale containers automatically, mark "error" if the restart also fails
- [x] Per-tenant health endpoint: `GET /api/tenants/:id/health` (any member)
- [x] Instance hibernation: `lastActivityAt` tracking (debounced 5min), `hibernateAfterDays` setting (0=disabled)
- [x] The monitor sweep stops idle tenants automatically after the threshold, and the app writes an audit log as `tenant_hibernated`
- [x] Hibernation settings in the Security tab with a relative-time display of the last activity

### 4.3 Production deployment
- [x] Production Caddy config with wildcard TLS (Caddyfile.production, DNS challenge)
- [x] Client metadata hosted at `/.well-known/atproto-client-metadata.json`
- [x] JWKS endpoint for production OAuth (`/.well-known/jwks.json`)
- [x] Rate limiting (express-rate-limit: auth + .well-known 10/min, API 60/min)
- [x] DB-backed auth state/session stores (oauth_states, oauth_sessions tables + connect-pg-simple)
- [x] Port race condition retry (catches PG 23505, retries up to 3 times)
- [x] Structured logging (Pino, `LOG_LEVEL` env, replaces all console.log/error)

### 4.4 UX polish
- [x] Sidebar navigation (grouped vertical nav replaces the tab bar that wraps)
- [x] Mobile-responsive (hamburger menu, sidebar overlay, stacking stat cards)
- [x] Setup wizard (3-step onboarding: tailnet ready → connect device → invite someone)
- [x] Network status tab (instance health + device online/offline counts)
- [x] Stat summary bar (devices, members, tenant status, health at a glance)
- [x] Structured logging: the Pino logger replaces all console.error in all route files

---

## Phase 6: Self-contained mesh — "Own every part" (ADR-0026 to ADR-0033)

Order matters: each stage gives value alone and unblocks the next.

### 6.0 Done in this cycle
- [x] Security review rounds 1 and 2: login CSRF nonce, Bearer fallback, member key limits, lockdown revocation, role escalation via default role, bounded credential issuance (fca4af7, ffe16a7)
- [x] Tailnet and member names in Tailscale clients: coordinator identity registry (1406883)
- [x] Public tailnet addresses: `tenant_hostnames`, random friendly names, privacy fixes (15236e6 — ADR-0026 §1-2)

### 6.0b Sign-in is identification only
- [x] `atproto` scope only; session revoked in the callback; stored sessions purged; public profile lookup from the DID document (b825e10)

### 6.1 Tailnet addresses and shared control URL (ADR-0026)
- [x] Run migration 0030 against a throwaway PostgreSQL (copy of the live data: applies, idempotent, one-primary index enforced)
- [x] `control.<APEX_DOMAIN>`: Caddy site, `CONTROL_DOMAIN` config; login server everywhere uses it (DNS record at deploy)
- [ ] Legacy per-tailnet hostnames: keep routing until retired; extra DNS record (ADR-0028)
- [ ] Commit, deploy; set the address of the existing tailnet; move the Mac to the shared URL; retire `daveforan-bsky-social`

### 6.2 Built-in DERP relay and STUN (ADR-0027)
- [x] `coord-derp` crate: frames, handshake (NaCl box), connection table, forwarding, keepalive, PeerGone
- [x] Helper endpoints (WebSocket transport deferred: browser clients only)
- [x] Member-only check of node keys against the store; per-node limits
- [x] STUN server on UDP 3478
- [ ] Deploy: `derp.<APEX_DOMAIN>`, Caddy proxy, UDP 3478 in the cloud firewall, default DERP map → built-in region
- [ ] Verify with Mac + phone (`tailscale netcheck`, relayed then direct)

### 6.3 Interactive device sign-in (ADR-0032)
- [ ] Coordinator: pending registrations, AuthURL, waiting map request, completion API
- [ ] TS service: `/device/:id` approval page (Bluesky sign-in, tailnet choice), all key-path checks
- [ ] Remove the `example.com` placeholder
- [ ] Verify on iOS and Android

### 6.4 Coordinator DNS (ADR-0028)
- [ ] Per-tenant DNS registry + `PUT /api/tenants/{id}/dns`, pushed and replayed by the TS service
- [ ] Split-DNS route for `BASE_DOMAIN` with upstream resolvers (never empty); extra records
- [ ] Device names `<device>.<tailnet-name>.<BASE_DOMAIN>` and search domain
- [ ] Verify device names on Mac and phone; verify the control URL still resolves

### 6.5 Gateway node (ADR-0029)
- [ ] Phase 1: coordinator-registered tagged node, WireGuard, DERP client; Mac pings the gateway
- [ ] Phase 2: disco; direct path to the gateway
- [ ] Phase 3: per-tailnet userspace TCP/IP; proxy TCP to a port on the Mac
- [ ] Caller identity from tailnet address (in-process lookup)

### 6.6 Named tailnet services (ADR-0030)
- [ ] Service model: name, device, port, visibility; shared namespace with tailnet addresses
- [ ] Gateway: TLS with the wildcard certificate, routing by server name, identity headers
- [ ] Extra DNS records for services; ACL rule for gateway → targets
- [ ] Dashboard publish flow, "Post to board", MCP tool
- [ ] Verify `https://<name>.<BASE_DOMAIN>` from a second device; not reachable from outside

### 6.7 Public service exposure (ADR-0031)
- [x] `__Host-` dashboard session cookie (7e7b3e7)
- [ ] Decide and register `PUBLIC_SERVICE_DOMAIN`
- [ ] Operator enable per tailnet + per-service approval, audit, kill switch
- [ ] Caddy public side → gateway; `public` and `public-signed-in` modes
- [ ] Rate, body-size and bandwidth limits; access logs

### 6.8 Federation data plane and service records (ADR-0033)
- [ ] Gateway-to-gateway link; advertise agreed CIDRs; enforce traversal policy
- [ ] Hierarchy: child services and routes visible to parents by posture
- [ ] `cloud.mesotechnics.service` lexicon; write/verify records; board as a view of records

### 6.9b Device visibility and consensual sharing (ADR-0036)
- [x] Coordinator: access mode, per-device filter and peer list, stored rules, admin API (0594e66)
- [x] TS service: data model (migration 0031), access rule compiler and coordinator sync
- [x] TS service routes: service posts with approval and Connect, friends, blocks, shares, access mode, controller board text
- [x] Dashboard: Boards and Friends & Sharing screens; controller board on the landing page
- [x] Migrations 0030 and 0031 dry-run against a copy of the live database
- [ ] Missing interface parts: choose guest devices on accept, narrow ports on accept, per-device "who can reach this"
- [ ] Private DNS names (needs 6.4); enroll a new device inside the add-service form
- [ ] Verify with two members and two real devices

### 6.10 Device-bound access (ADR-0035)
- [ ] WebAuthn verification (node:crypto + CBOR), challenge store, trusted-device table
- [ ] Two-step sign-in, refusal + notification for other devices, device limit
- [ ] Add-device approval from a trusted device; step-up for sensitive actions
- [ ] Recovery codes; operator reset with delay
- [ ] Self-lock of tailnet machines; coordinator enforces locks at registration

### 6.11 High availability and Kubernetes (ADR-0034)
- [ ] Stage A: coordinator config in the database; LISTEN/NOTIFY event bus; advisory-lock leader for TS loops; shared MCP secret
- [ ] Stage B: coordinator roles (control / relay / all); one DERP region per relay; real home relay per device; relay discovery table
- [ ] Stage C: `deploy/kubernetes/` Kustomize manifests, cert-manager TLS, STUN UDP services, Secrets for keys, probes and disruption budgets; docs
- [ ] Verify: replica loss during a ping between two devices

### 6.9 Operations (no ADR)
- [ ] DigitalOcean backups + nightly `pg_dump` and coordinator key off the droplet; test a restore
- [ ] Uptime check on `/health` and droplet alerts (CPU, memory, disk)
- [ ] One-command deploy script (parity check, build, restart, verify)
- [ ] Confirm domain auto-renew at the registrar

---

## Out of scope (for now)

- ~~Custom DERP relays per tenant~~ ✅ Implemented (custom regions, embedded toggle, public relay toggle)
- ~~Per-tenant IP range configuration~~ ✅ Implemented (v4/v6 prefixes, sequential/random allocation)
- ~~Exit nodes / subnet routers management UI~~ ✅ Implemented (list/enable/disable/delete routes, split exit nodes vs subnets)
- ~~Billing / usage metering~~ ✅ Implemented (usage snapshots, plan names, device/member limits, history API, dashboard Usage tab)
- ~~Federation between tailnets~~ ✅ Implemented (request/accept/reject/revoke links, bidirectional CIDR sharing, dashboard Federation tab)
- Headscale fork for true multi-tenancy in a single process (see ADR-0002 — escape hatch)

---

## Tech stack summary

| Layer | Technology |
|-------|-----------|
| Language | TypeScript |
| API framework | Express 5 |
| Database | PostgreSQL (service state) + SQLite (for each Headscale instance) |
| ORM | Drizzle |
| Auth | `@atproto/oauth-client-node` |
| Control plane | Headscale (Docker containers, one for each tenant) |
| Reverse proxy | Caddy (wildcard TLS, dynamic upstreams) |
| Process management | Docker (dev), systemd or K8s (prod) |
| Frontend | TBD — React SPA or server-rendered (decide in Phase 1.5) |
