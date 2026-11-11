# atproto-tailnet

Tailscale-as-a-service where users authenticate with their AT Protocol (Bluesky) identity, receive isolated tailnets, and invite others by handle.

## Architecture

- **Service API**: TypeScript / Express 5 / Drizzle ORM / PostgreSQL
- **Control plane**: One Headscale Docker container per tenant (see ADR-0002) — being replaced by Rust coordinator (ADR-0023)
- **Coordinator** (Phases 1-3 complete): Rust workspace at `coordinator/` — purpose-built mesh coordinator replacing Headscale (ADR-0023). 8 crates: coord-core (types/traits including federation Link/Session/DID types, DEFAULT_IPV4/IPV6_PREFIX constants), coord-noise (Noise IK handshake via `snow`, transport via direct `chacha20poly1305` with Tailscale-compatible BE nonces, poison-recovering Mutex), coord-proto (Tailscale control protocol messages), coord-acl (PolicyEngine with per-tenant rules → Tailscale FilterRule), coord-store (MemoryStore with broadcast events + PgStore with sqlx, shared generate_random_id + PEER_EVENT_CHANNEL_CAPACITY), coord-api (axum + hyper H2, admin auth middleware + federation message routes), coord-federation (13 modules: protocol, session, route_engine, abuse, scoping, handshake, auth, transport, discovery, store, broker, inbound, federation_store_memory, pg_store — 5,400+ lines, 92 unit tests), coord-server (binary with broker tick loop, TOML config + env vars, uses create_pool). Protocol: JSON over HTTP/2 over Noise IK (`Noise_IK_25519_ChaChaPoly_BLAKE2s`). Key endpoints: `GET /key` (JSON mkey format), `POST /ts2021` (upgrade → Noise → H2), `POST /machine/register` (pre-auth key, node key rotation via OldNodeKey), `POST /machine/map` (streaming long-poll with zstd framing, delta PeersChanged/PeersRemoved, 60s keepalives, disco key propagation, HomeDERP field). Admin: `POST /api/preauth-keys`, `GET /api/nodes`, `POST /api/acl`, `POST/GET /api/tenants`, `GET/DELETE /api/tenants/{id}`, `GET /api/tenants/{id}/routes` — constant-time Bearer token auth when COORD_ADMIN_KEY set. Federation: `POST /api/federation/messages/{hello,commit,keepalive,revoke,link-request,link-accept,link-reject,link-revoke}` — CFP-Recipient header for collective DID routing, InboundHandler with RateLimiter (60 req/min per DID) + ReplayGuard (5 min window) dispatches to dyn FederationStore (PgFederationStore when DATABASE_URL set, FederationMemoryStore otherwise). Security: SSRF DNS rebinding defense (async hostname resolution rejects private IPs), poison-recovering locks, saturating arithmetic on priority scores, zstd panic elimination, signature verification never bypassed on serialization failure, 2 MiB DefaultBodyLimit on all axum routes, ControlKey Debug redaction. Multi-tenant with sub-collective hierarchy: parent tenants see aggregated routes from child tenants gated by child's `federation_posture` (Closed blocks, Selective/Open allow). Store enum dispatch (MemoryStore for dev, PgStore when DATABASE_URL set). Session generation counter prevents reconnect races. Configurable DERP map (JSON file or env `COORD_DERP_MAP`), listen addr (`COORD_LISTEN`), TOML config file as CLI arg. 201 Rust tests across workspace (92 federation unit, 42 API control_flow, 5 API smoke (real TCP), 21 PgStore integration, 18 PgFederationStore integration, 9 store unit, 3 ACL, 11 noise). Port 8443 is used by tailscale on this machine — do NOT use it
- **Auth**: AT Protocol OAuth via `@atproto/oauth-client-node` (see ADR-0003)
- **Reverse proxy**: Caddy with admin API for dynamic subdomain routing
- **Security model**: Composable role-based permissions, device approval, lockdown (see ADR-0005)
- **ADRs**: `docs/adr/0001-0023` — read these before changing architecture. ADR-0013 (Go fork) superseded by ADR-0023 (Rust coordinator). ADR-0024 (purpose-built client) is proposed/future

## Development

```sh
# Prerequisites: Docker, Node.js 22+
cp .env.example .env
docker compose up -d             # PostgreSQL + Caddy
npm install --include=dev        # NODE_ENV=production is set globally on this box
npx drizzle-kit generate         # Generate migrations
npx drizzle-kit migrate          # Apply migrations
npm run dev                      # http://127.0.0.1:3000 (loads .env via --env-file)
```

### Coordinator mode (local dev)
```sh
# Runs Postgres + Rust coordinator + Caddy in Docker; TS service on host
docker compose -f docker-compose.coordinator.dev.yml up -d
# Add to .env: COORDINATOR_URL=http://localhost:9443  COORDINATOR_API_KEY=dev-coordinator-key
npm run dev
```

### Full coordinator stack (Docker)
```sh
cp .env.coordinator.example .env   # Edit secrets
docker compose -f docker-compose.coordinator.yml up -d
```

## Key patterns

- **Control client abstraction**: `getControlClient(tenant)` from `orchestrator/control-client.ts` — returns either `HeadscaleApiClient` or `CoordinatorApiClient` based on `COORDINATOR_URL` env var. All route handlers and orchestrator modules use this factory, never `new HeadscaleApiClient(...)` directly. The `ControlClient` interface matches the Headscale API surface; coordinator operations that aren't implemented yet are graceful no-ops
- **Coordinator mode** (`COORDINATOR_URL`): when set, tenant provisioning creates tenants via the coordinator REST API (`POST /api/tenants`), stores the coordinator-side UUID in `tenants.coordinatorTenantId`, and skips Docker container lifecycle. Caddy routes all tenant subdomains to the single coordinator. Health monitor skips Docker restarts
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
- All config flows through Zod-validated `src/config.ts` (including caddyAdminUrl, databaseUrl, atprotoPrivateKey, federationKeyEncryptionKey, tenantPublicPort, headscale.network)
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
- Instance hibernation: `hibernateAfterDays` setting (0 = disabled), `lastActivityAt` updated on API access (debounced 5 min); monitor sweep auto-stops idle tenants past threshold
- `getTenantForUser` touches `lastActivityAt` fire-and-forget when >5 min stale
- Custom DERP relays: `GET/PUT /api/tenants/:id/derp` — per-tenant DERP regions (YAML files hot-reloaded by Headscale), embedded DERP toggle (requires restart), public relay toggle; gated by `manage_acl`; region IDs 900-999
- DERP config writes: `updateInstanceConfig()` in `orchestrator/headscale.ts` rewrites config.yaml + derp-custom.yaml; `writeDerpRegionsFile()` generates the YAML paths file
- Per-tenant IP ranges: `GET/PUT /api/tenants/:id/ip-config` — customize IPv4/IPv6 CIDR prefixes and allocation strategy (sequential/random); gated by `manage_settings`; changes trigger container restart
- Exit nodes / subnet routers: `GET /api/tenants/:id/routes` returns `{ exitNodes, subnets }` from Headscale; `POST .../routes/:routeId/enable|disable`, `DELETE .../routes/:routeId`; gated by `manage_devices`; routes are advertised by devices, admin approves/rejects
- Headscale API is pinned to 0.29.x semantics (`orchestrator/headscale-api.ts`): users are addressed by numeric id (the client resolves names via `getUserByName`), routes are fields on a node (`availableRoutes`/`approvedRoutes`) changed through `POST /node/:id/approve_routes`, so route ids are synthesized by `routeId(nodeId, prefix)` and "delete" withdraws approval; node `expiry`/`lastSeen`/`user` can be null. Check a running instance's `/swagger/v1/openapiv2.json` before adding calls
- Usage metering: `GET /api/tenants/:id/usage` returns live counts + plan limits + 7-day snapshot history (168 entries, every 5 min); `PUT /api/tenants/:id/plan` for plan name + max devices/members; `usage_snapshots` table; monitor records snapshots every 5th tick
- Federation: `GET/POST /api/tenants/:id/federation` for links; `POST .../federation/:linkId/accept|reject|revoke`; `federation_links` table with bidirectional CIDR sharing; gated by `manage_settings`; both sides can revoke active links
- Collective signing keys: one implementation in `src/identity/keys.ts` (`signDetached`/`verifyDetached` detached-JWS EdDSA, `encryptPrivateKey`/`loadPrivateKey`); DB-backed access via `loadCollectiveKeyPair(tenantId)` / `signAsCollective(tenantId, payload)` in `orchestrator/federation-broker.ts` — never decode `collective_dids.encryptedPrivateKey` by hand
- Collective DIDs: `did:web:<host>:collective:<slug>` (port percent-encoded), document served at `/collective/:slug/did.json`; `getResolver()` (`identity/resolver.ts`) answers local collectives from the DB and refuses did:web hosts that resolve to non-public addresses
- Federation broker (ADR-0016): two `broker_sessions` per active link (one per side, unique on link + `localTenantId`); accepting side initiates HELLO→CHALLENGE→COMMIT→ESTABLISHED over `POST /api/federation/messages/{hello,commit}`; reconcile loop (30s) retries `connecting` sessions, sends signed keepalives, tears down sessions of inactive links
- CFP message auth (`federation/auth.ts`): recipient collective named by `CFP-Recipient` header; signatures verified over `req.body` as transmitted (never the Zod output — key order matters); HELLO requires an active link with the sender; keepalive/revoke must be signed by the session's peer
- Federated routes: only prefixes agreed on the link are imported (`filterImportedPrefixes`); installed as Headscale `autoApprovers.routes` for `tag:federation-relay`
- Credential revocation: `POST /api/tenants/:id/credentials/:credentialId/revoke` requires the credential `jwt` and only revokes credentials signed by that tenant's collective key
- Service-auth holder binding (ADR-0021): AT Proto accounts prove identity via `getServiceAuth` JWT (ES256K/ES256, `#atproto` key); verifier in `credentials/service-auth.ts` checks aud/lxm/exp/jti/signature via `@atproto/crypto.verifySignature`; BFF helper in `credentials/service-auth-bff.ts` calls `getServiceAuth` through stored OAuth session; JTI replay cache in `service_auth_jti_cache` table, swept by monitor
- Typed resolver keys (ADR-0021 §4): `resolveTyped(did, opts)` on `DIDResolver` returns `{key, algorithm, methodId, didKey?}` with `publicKeyMultibase` multikey decoding (secp256k1/P-256 via `@atproto/crypto`); callers filter by methodId and algorithms
- Tenant URLs: `tenantPublicUrl(slug)` in `config.ts` is the single source for the login server and Headscale `server_url` (`<proto>://<slug>.<BASE_DOMAIN>[:TENANT_PUBLIC_PORT]`)
- Caddy routing (`orchestrator/caddy.ts`): the service owns one route, `@id: tailnet_tenants`, kept first in the Caddy server named `tailnet_proxy` (named in the Caddyfile via `servers { name tailnet_proxy }`); `syncTenantRoutes()` rewrites it whole from the DB (all non-deleted tenants with a container) — call it after anything that adds/removes a tenant instance; the monitor also calls it every sweep because Caddy forgets admin-API changes on restart. Never add or remove individual routes
- Caddy admin API calls use `node:http`, not `fetch` — Caddy ≥ 2.11 rejects requests carrying `Sec-Fetch-Mode` (403)
- Tenant containers join the Docker network `HEADSCALE_NETWORK` (shared with Caddy), and Caddy dials `headscale-<slug>:8080`; without it Caddy dials `localhost:<port>` and must run on the host. `ensureOnTenantNetwork()` attaches older containers at startup
- Schema changes need `npx drizzle-kit generate` — commit the generated migration with the schema change

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
  credentials/
    verifier.ts            — VC-JWT and holder-binding verification, PublicKeyResolver interface, ResolvedKey type
    issuer.ts              — VC-JWT issuance (membership, role, capability), bundle assembly, challenge generation
    service-auth.ts        — AT Proto service-auth JWT verification (ES256K/ES256 via @atproto/crypto), JTI replay cache
    service-auth-bff.ts    — BFF helper: obtains service-auth token via user's OAuth session
    types.ts               — Credential type definitions
  identity/
    keys.ts                — Collective key encryption at rest + detached-JWS sign/verify
    resolver.ts            — did:web / did:plc resolver (local-collective lookup, SSRF guard, typed multikey decoding, cache)
  federation/
    auth.ts                — CFP message signing/verification, freshness, imported-route filtering
    transport.ts           — Outbound CFP messages over HTTP (CFP-Recipient addressing)
    handshake.ts, protocol.ts, session.ts, route-engine.ts, scoping.ts — CFP state machines and types (ADR-0014/0015)
  orchestrator/
    federation-broker.ts   — Broker loop, per-link sessions, outbound handshake, collective DID lifecycle, ACL route install
    headscale.ts           — Docker lifecycle (create/start/stop/destroy), CLI exec, DERP config writer
    headscale-api.ts       — REST client for running Headscale instances (includes getPolicy/setPolicy)
    caddy.ts               — Caddy admin API: one managed tenant route synced from the DB
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
    derp.ts                — Custom DERP relay management (regions, embedded toggle, public relay toggle)
    ip-config.ts           — Per-tenant IP range configuration (v4/v6 prefixes, allocation strategy)
    routes.ts              — Exit node and subnet router management (enable/disable/delete routes)
    usage.ts               — Usage metering and plan/limit management
    federation.ts          — Federation link CRUD (request/accept/reject/revoke between tailnets), collective DID + discovery documents
    federation-messages.ts — Inbound CFP endpoints (hello/commit/keepalive/revoke), DID-signature authenticated
    credentials.ts         — VC-JWT issuance, public verify, holder-binding challenges, revocation, service-auth presentation + BFF token minting
    dashboard.ts           — Inline SPA (tabbed: Status, DERP, IP Ranges, Routes, Devices, Members, Invite, Services, Board, Federation, Agents, ACL, Roles, Usage, Security, Audit) + /join/:slug
    helpers.ts             — Shared middleware, param(), permission checks, agent token resolution, hs username/URL helpers
    audit.ts               — Fire-and-forget audit log writer
docs/adr/                  — Architecture Decision Records (0001-0024)
BUILD_PLAN.md              — Phased build tracker
coordinator/               — Rust mesh coordinator workspace (ADR-0023)
  crates/
    coord-core/            — TenantId, NodeId, ControlKey, MachineKey, error types
    coord-noise/           — Noise IK handshake + encrypted transport (snow-based)
    coord-proto/           — Tailscale control protocol messages (RegisterRequest/Response, MapRequest/Response)
    coord-acl/             — ACL policy engine (trait)
    coord-store/           — PostgreSQL storage (sqlx)
    coord-api/             — REST management API (axum)
    coord-federation/      — Federation broker: protocol types, session lifecycle, route engine, abuse/scoping, handshake state machine, auth, transport, discovery, store trait, broker service, inbound handlers
    coord-server/          — Binary entrypoint
```
