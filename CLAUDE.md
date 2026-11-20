# atproto-tailnet

Tailscale-as-a-service where users authenticate with their AT Protocol (Bluesky) identity, receive isolated tailnets, and invite others by handle.

## Architecture

- **Service API**: TypeScript / Express 5 / Drizzle ORM / PostgreSQL
- **Dashboard**: React 19 / esbuild / lazy-loaded tabs / typed service layer (16 domain modules)
- **Control plane**: Rust coordinator (default) or one Headscale Docker container per tenant (legacy)
- **Coordinator**: Rust workspace at `coordinator/` — purpose-built mesh coordinator replacing Headscale. 10 crates (adds coord-netmap and coord-derp, the DERP relay + STUN): coord-core (types/traits including federation Link/Session/DID types, DEFAULT_IPV4/IPV6_PREFIX constants), coord-noise (Noise IK handshake via `snow`, transport via direct `chacha20poly1305` with Tailscale-compatible BE nonces, poison-recovering Mutex), coord-proto (Tailscale control protocol messages), coord-acl (PolicyEngine with per-tenant rules → Tailscale FilterRule), coord-store (MemoryStore with broadcast events + PgStore with sqlx + SqliteStore with sqlx-sqlite, shared generate_random_id + PEER_EVENT_CHANNEL_CAPACITY), coord-api (axum + hyper H2, admin auth middleware + federation message routes), coord-federation (14 modules: protocol, session, route_engine, abuse, scoping, handshake, auth, transport, discovery, store, broker, inbound, federation_store_memory, pg_store, sqlite_store — 5,800+ lines, 94 unit tests), coord-server (binary with broker tick loop, TOML config + env vars, uses create_pool). Protocol: JSON over HTTP/2 over Noise IK (`Noise_IK_25519_ChaChaPoly_BLAKE2s`). Key endpoints: `GET /key` (JSON mkey format), `POST /ts2021` (upgrade → Noise → H2), `POST /machine/register` (pre-auth key, node key rotation via OldNodeKey), `POST /machine/map` (streaming long-poll with zstd framing, delta PeersChanged/PeersRemoved, 60s keepalives, disco key propagation, HomeDERP field). Admin: `POST /api/preauth-keys`, `GET /api/nodes`, `POST /api/acl`, `POST/GET /api/tenants`, `GET/DELETE /api/tenants/{id}`, `GET /api/tenants/{id}/routes`, `GET/PUT /api/tenants/{id}/identity` (tailnet name → netmap `Domain`, owner id → `{login_name, display_name}` → per-owner Tailscale users/profiles, stable FNV user ids, placeholders when unknown; in-memory, pushed by TS `orchestrator/coordinator-identity.ts` at key issuance, coordinator resync and every 5th monitor tick), `GET/PUT /api/tenants/{id}/derp` (per-tenant DERP override via `DerpRegistry` in coord-netmap: custom regions 900-999 plus optional operator default map; in-memory, TS service is the source of truth) — constant-time Bearer token auth when COORD_ADMIN_KEY set. Federation: `POST /api/federation/messages/{hello,commit,keepalive,revoke,link-request,link-accept,link-reject,link-revoke}` — CFP-Recipient header for collective DID routing, InboundHandler with a pre-verification global rate limit (1200/min), per-DID RateLimiter (60 req/min, after signature verification) and a ReplayGuard keyed on sender+type+message id (recorded after verification, 660s retention, 100k cap) dispatches to dyn FederationStore (PgFederationStore for postgres, SqliteFederationStore for sqlite, FederationMemoryStore for memory backend). Security: SSRF DNS rebinding defense (async hostname resolution rejects private IPs), poison-recovering locks, saturating arithmetic on priority scores, zstd panic elimination, signature verification never bypassed on serialization failure, 2 MiB DefaultBodyLimit on all axum routes, ControlKey Debug redaction. Multi-tenant with sub-collective hierarchy: parent tenants see aggregated routes from child tenants gated by child's `federation_posture` (Closed blocks, Selective/Open allow). Store enum dispatch (MemoryStore for dev, PgStore for postgres, SqliteStore for sqlite — backend selected via `store_backend` config key or `COORD_STORE_BACKEND` env var, required/explicit). SQLite uses WAL mode, counter table for IP allocation now picks the lowest address no live node holds (advisory lock in PG, BEGIN IMMEDIATE in SQLite) so freed addresses are reused, migrations in `migrations_sqlite/` (shared by coord-store and coord-federation). Federation store follows the same backend selection: SQLite gets SqliteFederationStore (persistent), postgres gets PgFederationStore, memory gets FederationMemoryStore. Session generation counter prevents reconnect races. Configurable default DERP map (JSON file or env `COORD_DERP_MAP`), persisted Noise control key (`COORD_CONTROL_KEY_PATH`; Noise frames capped at 4096 bytes to match Tailscale controlbase), listen addr (`COORD_LISTEN`), sqlite path (`COORD_SQLITE_PATH`, default `coordinator.db`), TOML config file as CLI arg. 210 Rust tests across workspace (94 federation unit, 42 API control_flow, 5 API smoke (real TCP), 21 PgStore integration, 18 PgFederationStore integration, 9 store unit, 3 ACL, 11 noise). Port 8443 is used by tailscale on this machine — do NOT use it
- **Auth**: AT Protocol OAuth via `@atproto/oauth-client-node`, identity scope only (`atproto`); no account tokens are kept
- **Reverse proxy**: Caddy with admin API for dynamic subdomain routing
- **Security model**: Composable role-based permissions, device approval, lockdown
- **ADRs**: `docs/adr/` — design decision records (0001-0024)

## Deployment

To deploy to DigitalOcean, follow `deploy/digitalocean/AGENT.md` step by step. It covers DNS, the Cloud Firewall, `.env` (secrets, `OPERATOR_DIDS`, `ATPROTO_PRIVATE_KEY` generated on the Droplet), TLS, first sign-in, and connecting Claude. It works with `doctl` or the DigitalOcean MCP server; Droplet-side steps need SSH. Never print secrets.

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
# Add to .env: COORDINATOR_URL=http://localhost:9443  COORDINATOR_API_KEY=dev-coordinator-key-local-only-0000000000
npm run dev
```

### Full coordinator stack (Docker)
```sh
cp .env.coordinator.example .env   # Edit secrets
docker compose -f docker-compose.coordinator.yml up -d
```

## Key patterns

- **Dashboard client**: React 19 SPA built by esbuild (`esbuild.config.ts`). Two entry points: `src/client/main.tsx` → `public/js/dashboard.js`, `src/client/join.tsx` → `public/js/join.js`. CSP: `script-src 'self'; style-src 'self'`
- **Tab architecture**: 20 lazy-loaded tabs via `React.lazy` + `Suspense`. Tab registry in `components/registry.ts` gates visibility by permission. `useAppState` context provides global state; `useTenantData` hook handles load-on-mount; `useTenantMutation` handles mutations with toast + busy state
- **Service layer (client)**: 16 typed modules in `services/`, one per API domain. All tabs and hooks use these instead of raw `fetch()`. `api.ts` is the low-level wrapper; domain modules re-export typed functions
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
- Session cookie: `sessionCookieName()` — `__Host-tailnet-session` over HTTPS (host-only, so no subdomain can set or replace it), `sameSite: "lax"`, httpOnly, 7 days
- AT Proto handle validation: `HANDLE_RE` regex rejects non-handle input before any HTTP/DNS resolution
- Handle resolution: DNS TXT → HTTP .well-known → Bluesky public API
- Auth state/session stores are DB-backed (`oauth_states`, `oauth_sessions` tables via Drizzle upsert)
- Express sessions stored in PostgreSQL via `connect-pg-simple`
- Rate limiting: auth + `.well-known` routes 10 req/min, API routes 60 req/min (`express-rate-limit`)
- `.well-known/atproto-client-metadata.json` and `.well-known/jwks.json` served for production AT Proto OAuth
- Port allocation retries on unique constraint violation (PG error 23505) up to 3 times
- Port range 10001-10100 allocated from DB; excludes every row's port and reclaims ports held by deleted tenants (deleted rows move to a unique negative placeholder). Coordinator tenants and sub-collectives get negative placeholders — they never consume the Headscale range
- All config flows through Zod-validated `src/config.ts` (including caddyAdminUrl, databaseUrl, atprotoPrivateKey, federationKeyEncryptionKey, tenantPublicPort, headscale.network)
- Instance operators: `OPERATOR_DIDS` (env, comma-separated DIDs; `config.operatorDids`). Only operators — and DIDs an operator designates in `tailnet_creators` — get a tailnet; everyone else signs in to a no-access view (pending invitations + "request to join" the default tailnet via the existing join-request API). Single entry point `canCreateTailnet(user)` in `src/operator/policy.ts`, wrapped with `withTailnetCreationLock` (in-process; the service runs as one app process). `instance_settings` singleton: `singleTailnet` (also refuses sub-collectives, 409 `single_tailnet`), `defaultTailnetId` (first operator tailnet claims it and gets `allowJoinRequests=true`; setting a new default enables join requests). Operator API `/api/operator/*` (`requireOperator`: session or MCP token, never agent tokens): overview, settings, tailnet creators, suspend/unsuspend (`tenants.suspended`, coordinator `PUT /api/tenants/{id}/suspended`; members get 403 `tenant_suspended`; suspended children are hidden from parents), operator delete, user disable/enable (`users.disabled_at`; disable runs the kick cascade `removeMemberCascade`). Enforcement middleware `enforceOperatorState` (`src/operator/access.ts`). Public `GET /api/instance`. `POST /api/tenants/mine` creates your tailnet if allowed
- Invitations are the per-tailnet allow-list: invite by handle or DID; responses carry `inviteUrl` (`/invite/:id`, served by the dashboard, sign-in redirect for anonymous visitors). Nothing is sent automatically — admins share the link
- Device approval: devices connect freely by default; when `requireDeviceApproval` is true, auth-key requests create pending `device_approvals` and notify approvers; an approver approves to generate the key. `maxDevices` is enforced at key issuance and approval
- Auth keys: every issued key is tracked in `auth_keys` (both modes). `GET /api/tenants/:id/auth-keys` (manage_devices/originator see all, others own), `DELETE .../auth-keys/:keyId`. Coordinator keys carry `owner` (our user id) and `tags`; the node inherits them, which is how device ownership works in coordinator mode. Kicking a member revokes their keys and deletes their devices in both modes
- Notifications (`src/notifications/`): per-recipient rows (originator + holders of the matching approve_* permission) for device/join/service approval requests and limit hits; `GET .../notifications`, `POST .../notifications/read`. Optional per-tenant webhook (`notificationWebhookUrl` + write-only secret, HMAC-SHA256 `X-Atproto-Tailnet-Signature`), https + public addresses only unless `WEBHOOK_ALLOW_PRIVATE=true` (single-org self-hosting), address re-checked at connect time, no redirects, fire-and-forget
- Device locks: `device_locks` table binds a membership to specific Headscale `machineKey` values — blocks new key generation until unlocked
- Join requests: `allowJoinRequests` toggle + public `/join/:slug` page; gated by `approve_joins` permission; lockdown blocks requests
- Post-login redirect: `req.session.postLoginRedirect` stores destination (validated as local path) through OAuth flow
- Device access (ADR-0036): `tenants.accessMode` is `open` (allow-all or the ACL policy) or `member` (default for new coordinator tailnets: a device reaches only its owner's devices). Everything else is opened by rules compiled in `access/compiler.ts` (pure) from approved public service posts + their connections and active, unexpired shares, pushed by `syncTenantAccess(tenantId)` (`access/sync.ts`) to the coordinator's `PUT /api/tenants/{id}/access`, which persists them and builds a per-device packet filter and peer list (`member_view` in coord-netmap). Call `syncTenantAccess` after any change to posts, connections, shares or the mode. Coordinator mode only
- Boards (`routes/boards.ts`): three audiences. Controller board = the originator's public text (`tenants.controllerBoardText`, Markdown subset in `shared/board-text.ts`, linted, rendered by our own code, never HTML/JS; public at `/board/<address>` and on the landing page). Public board = `service_posts` with one device + one port, visible to members only after `approve_services` approval (originator's own posts skip it); members Connect chosen devices of their own (`service_connections`), which opens that one port. Private board = a member's services for their own devices with private names. Changing a public post's device/port drops connections and needs a new approval. Operators control public posts only (`manage_board` removes)
- Friends and shares (`routes/sharing.ts`): only accepted friends can share; a share exposes one device of the owner on listed ports/protocols to the guest's devices and is active only after the side that did not start it accepts (an owner who narrows ports sends it back to the guest). Either side ends it. Blocks stop friend requests. No agent tokens, no operator access to share scope
- Agent tokens: `at_`-prefixed Bearer tokens for AI agents; SHA-256 hashed storage; scoped to single tenant + permission subset; mandatory expiry (max 365 days)
- Agent middleware chain: `resolveAgentToken` (Bearer → hash lookup + tenant toggle check → req.agentToken) → `enforceAgentScope` (tenant UUID match + non-tenant route allowlist) → `requireAuth` → route handlers
- Agent token settings: `allowAgentTokens` master toggle, `allowMemberAgentTokens` member toggle; checked at token resolution time (not just creation)
- Agent auth helpers: `authUserId(req)` returns user ID from session or token; `authUserDid(req)` resolves DID (session or DB lookup). All route files use these instead of `req.session.userId` directly
- Agent scope enforcement: `enforceAgentScope` allows `/api/me`, `/api/permissions`, `/api/tenants`, `/health` without tenant UUID; all other non-tenant routes blocked
- Non-member responses: always 404 "Tenant not found" (never 403 — avoids leaking tenant existence)
- Guard clause ordering: param extraction → getTenantForUser → hasPermission → lockdown check → body validation → business logic
- List queries capped at `.limit(200)` with explicit `.orderBy()`
- Tenant lifecycle (delete/start/stop) audit-logged as `tenant_deleted`/`tenant_started`/`tenant_stopped`
- 17 permissions total: invite, kick, manage_roles, manage_settings, approve_devices, approve_joins, approve_services, lock_devices, view_audit_log, manage_devices, manage_services, manage_board, create_posts, create_agent_tokens, manage_agent_tokens, manage_acl
- ACL management: `GET/PUT /api/tenants/:id/acl` — fetch/push Headscale ACL policy (groups, hosts, tagOwners, autoApprovers); gated by `manage_acl`; Zod-validated before push
- Health monitoring: background 60s interval (`orchestrator/monitor.ts`) probes all running tenants via Headscale REST, auto-restarts failed containers, marks "error" if restart fails
- Per-tenant health endpoint: `GET /api/tenants/:id/health` — any member, returns live Headscale probe result
- Structured logging: `pino` via `src/logger.ts`; `LOG_LEVEL` env var (default: info); replaces all console.log/error
- Instance hibernation: `hibernateAfterDays` setting (0 = disabled), `lastActivityAt` updated on API access (debounced 5 min); monitor sweep auto-stops idle tenants past threshold
- `getTenantForUser` touches `lastActivityAt` fire-and-forget when >5 min stale
- Custom DERP relays: `GET/PUT /api/tenants/:id/derp` — per-tenant DERP regions (YAML files hot-reloaded by Headscale), embedded DERP toggle (requires restart), public relay toggle; gated by `manage_acl`; region IDs 900-999. In coordinator mode the DB row stays the source of truth; PUT pushes `{regions, include_default}` to the coordinator's tenant-scoped `PUT /api/tenants/{coordinatorTenantId}/derp` via `CoordinatorApiClient.setDerp`; `embeddedDerpEnabled` is always false in coordinator mode. Never add a global (cross-tenant) DERP write path
- DERP config writes: `updateInstanceConfig()` in `orchestrator/headscale.ts` rewrites config.yaml + derp-custom.yaml; `writeDerpRegionsFile()` generates the YAML paths file
- Per-tenant IP ranges: `GET/PUT /api/tenants/:id/ip-config` — customize IPv4/IPv6 CIDR prefixes and allocation strategy (sequential/random); gated by `manage_settings`; changes trigger container restart
- Exit nodes / subnet routers: `GET /api/tenants/:id/routes` returns `{ exitNodes, subnets }` in both modes; `POST .../routes/:routeId/enable|disable`, `DELETE .../routes/:routeId` (withdraws approval); gated by `manage_devices`. Coordinator: advertised routes come from Hostinfo.RoutableIPs, approval via `POST /api/tenants/{id}/nodes/{node_id}/routes`, tag-based auto-approvers via `PUT /api/tenants/{id}/auto-approvers` (in-memory; TS stores them in `tenants` and the monitor replays them on coordinator `boot_id` change)
- Headscale API is pinned to 0.29.x semantics (`orchestrator/headscale-api.ts`): users are addressed by numeric id (the client resolves names via `getUserByName`), routes are fields on a node (`availableRoutes`/`approvedRoutes`) changed through `POST /node/:id/approve_routes`, so route ids are synthesized by `routeId(nodeId, prefix)` and "delete" withdraws approval; node `expiry`/`lastSeen`/`user` can be null. Check a running instance's `/swagger/v1/openapiv2.json` before adding calls
- Usage + limits: `GET /api/tenants/:id/usage` returns `{current, limits, overLimit, history}` (7-day snapshots, every 5 min); `PUT /api/tenants/:id/limits` sets `maxDevices`/`maxMembers` (0 = unlimited) — originator only, never via agent token; sub-collectives can't exceed the parent. There are no plans (`plan_name` column is unused). Caps are enforced: devices at key issuance/approval, members at invitation accept/join approval (403 `code: device_limit|member_limit`)
- Federation: `GET/POST /api/tenants/:id/federation` for links; `POST .../federation/:linkId/accept|reject|revoke`; `federation_links` table with bidirectional CIDR sharing; gated by `manage_settings`; both sides can revoke active links
- Collective signing keys: one implementation in `src/identity/keys.ts` (`signDetached`/`verifyDetached` detached-JWS EdDSA, `encryptPrivateKey`/`loadPrivateKey`); DB-backed access via `loadCollectiveKeyPair(tenantId)` / `signAsCollective(tenantId, payload)` in `orchestrator/federation-broker.ts` — never decode `collective_dids.encryptedPrivateKey` by hand
- Collective DIDs: `did:web:<host>:collective:<slug>` (port percent-encoded), document served at `/collective/:slug/did.json`; `getResolver()` (`identity/resolver.ts`) answers local collectives from the DB and refuses did:web hosts that resolve to non-public addresses
- Federation broker: two `broker_sessions` per active link (one per side, unique on link + `localTenantId`); accepting side initiates HELLO→CHALLENGE→COMMIT→ESTABLISHED over `POST /api/federation/messages/{hello,commit}`; reconcile loop (30s) retries `connecting` sessions, sends signed keepalives, tears down sessions of inactive links
- CFP message auth (`federation/auth.ts`): recipient collective named by `CFP-Recipient` header; signatures are detached EdDSA JWS over RFC 8785 JCS of the message minus `signature` (`federation/jcs.ts`; Rust `coord-federation` canonical.rs/signing.rs use the same bytes — shared vectors in `coordinator/crates/coord-federation/tests/fixtures/cfp_vectors.json`); verify against `req.body` as received so unknown fields stay covered; HELLO requires an active link with the sender; keepalive/revoke must be signed by the session's peer
- Federated routes: only prefixes inside CIDRs agreed on the link are imported (`filterImportedPrefixes`); Headscale mode installs them as `autoApprovers.routes` for `tag:federation-relay`, coordinator mode via coordinator auto-approvers. Cross-instance LINK_* messages go through a per-link outbox (`federation/outbox.ts`) with backoff; permanent revokes are never retried. The TS service is the authoritative CFP endpoint; the Rust CFP endpoints/broker only run with `COORD_FEDERATION_ENABLED=true`. The whole federation feature is off unless `FEDERATION_ENABLED=true` (src/config.ts): federation/traversal API paths return 404, the broker doesn't start, and the Federation/Traversal tabs are hidden via `features.federation` from `/api/me` (registry `feature` field + `tabEnabled`). Collective DID docs stay served for credentials
- Credential revocation: `POST /api/tenants/:id/credentials/:credentialId/revoke` requires the credential `jwt` and only revokes credentials signed by that tenant's collective key
- Sign-in is identification only: the AT Proto OAuth scope is `OAUTH_SCOPE = "atproto"` (never add `transition:*`), the session is revoked (`session.signOut()`) in the callback as soon as the DID is known, and the service keeps no account tokens (`purgeStoredOAuthSessions()` clears older ones at startup). Handle/display name/avatar come from public sources (`identity/account.ts`: PLC directory + Bluesky public API, handle verified both ways)
- Service-auth holder binding: AT Proto accounts prove identity via a `getServiceAuth` JWT (ES256K/ES256, `#atproto` key) minted by the holder's own client; verifier in `credentials/service-auth.ts` checks aud/lxm/exp/jti/signature via `@atproto/crypto.verifySignature`; JTI replay cache in `service_auth_jti_cache` table, swept by monitor. The service cannot mint these tokens for users (it holds no account access)
- Typed resolver keys: `resolveTyped(did, opts)` on `DIDResolver` returns `{key, algorithm, methodId, didKey?}` with `publicKeyMultibase` multikey decoding (secp256k1/P-256 via `@atproto/crypto`); callers filter by methodId and algorithms
- Tenant URLs: `tenantPublicUrl(slug)` in `config.ts` is the single source for the login server and Headscale `server_url` (`<proto>://<slug>.<BASE_DOMAIN>[:TENANT_PUBLIC_PORT]`)
- Caddy routing (`orchestrator/caddy.ts`): the service owns one route, `@id: tailnet_tenants`, kept first in the Caddy server named `tailnet_proxy` (named in the Caddyfile via `servers { name tailnet_proxy }`); `syncTenantRoutes()` rewrites it whole from the DB (all non-deleted tenants with a container) — call it after anything that adds/removes a tenant instance; the monitor also calls it every sweep because Caddy forgets admin-API changes on restart. Never add or remove individual routes
- Caddy admin API calls use `node:http`, not `fetch` — Caddy ≥ 2.11 rejects requests carrying `Sec-Fetch-Mode` (403)
- Caddy admin API (coordinator compose) listens on `10.250.250.2:2019` on the private `caddy_admin` network; only the app (pinned at `.3`) joins it. Tenant vhosts expose only `/key` and `/ts2021`
- Auth hardening: `/auth/login` refuses cross-site `Sec-Fetch-Site`, stores per-browser nonces (`session.oauthLoginNonces`) passed as OAuth `state`, and the callback must match one. An unresolved `Authorization: Bearer` is a 401 (never falls back to the session cookie). Members without `manage_devices` get single-use keys ≤ 24h; enabling lockdown revokes outstanding keys. Default-role changes and role deletion are checked with `missingPermissions` (no escalation via the default role). Agent tokens cannot mint agent tokens
- Built-in DERP relay + STUN (`coordinator/crates/coord-derp`, ADR-0027): the coordinator serves `GET /derp` (Upgrade: DERP), `/derp/probe`, `/derp/latency-check`, `/generate_204` and STUN on UDP 3478. `COORD_DERP_HOSTNAME` (compose: `DERP_DOMAIN`) makes it default DERP region 1; `COORD_STUN_LISTEN` (`off` disables); relay key at `COORD_DERP_KEY_PATH` (default `derp.key` next to the control key). Only registered nodes of non-suspended tenants are admitted (`StoreAdmission`, re-checked every keep-alive) and packets relay only within a tenant or between parent and child. The default DERP map never contains Tailscale's relays; with nothing configured it is empty. No mesh frames, no WebSocket transport
- Tenant containers join the Docker network `HEADSCALE_NETWORK` (shared with Caddy), and Caddy dials `headscale-<slug>:8080`; without it Caddy dials `localhost:<port>` and must run on the host. `ensureOnTenantNetwork()` attaches older containers at startup
- Tailnet addresses (`orchestrator/hostnames.ts`, `tenant_hostnames`): `tenants.slug` is a permanent opaque internal id (`t-` + 10 random chars for new tailnets; never derived from the handle) used only by the coordinator (`X-Tenant-Slug`, set by Caddy), Headscale container names and collective DIDs — never routed or returned publicly. Public names live in `tenant_hostnames`: one live primary (login server for new devices, join/board links) plus aliases (still routed so enrolled devices keep working); retired names stop routing and stay reserved 30 days. New tailnets get a random friendly name (`quiet-harbor-4821`) the originator is asked to change in the setup wizard; Status tab "Tailnet address" card. Originator-only, never agent tokens: `GET/PUT/DELETE /api/tenants/:id/hostnames[/primary|/:name]`; max 5 live names; reserved names blocked. Shared control URL: with `CONTROL_DOMAIN` set (coordinator mode) every tailnet's login server is `sharedControlUrl()` (`https://<CONTROL_DOMAIN>`, a static Caddyfile site exposing only `/key` + `/ts2021`; config refuses a host under `BASE_DOMAIN`) — use `tenantLoginServerFor(tenant)`, never build login URLs by hand. Caddy routes every live name (legacy per-tailnet control hostnames); `/internal/tls-check`, `/join/:name`, `/board/:name` resolve live public names only. Keep a DNS-01 wildcard TLS strategy in production — per-host (on-demand) certificates publish every tailnet name in Certificate Transparency logs
- Schema changes need `npx drizzle-kit generate` — commit the generated migration with the schema change

## File layout

```
src/
  client/                  — React 19 dashboard SPA
    main.tsx               — Dashboard entry point (StrictMode → AppProvider → ToastProvider → App)
    join.tsx               — Join page entry point (standalone state machine)
    App.tsx                — Root: 20 lazy-loaded tabs, PendingInvitations, SetupWizard
    components/
      Layout.tsx           — Header, Sidebar (SidebarProvider), LockdownBanner, LoginPage, StatsSummary
      Badge.tsx            — Status/role badge variants
      Card.tsx, EmptyState.tsx, Toast.tsx, Toggle.tsx — Shared UI primitives
      registry.ts          — Tab registry with permission gates
    hooks/
      useAppState.tsx      — Global context (user, tenant, settings, roles, stats, tab routing)
      useTenantData.ts     — Generic load-on-mount hook with reload
      useMutation.ts       — Mutation wrapper with toast + busy state
    services/              — 16 typed API modules (one per domain)
      api.ts               — Low-level fetch wrapper with CSRF
      acl.ts, agents.ts, audit.ts, collectives.ts, credentials.ts, devices.ts
      federation.ts, invitations.ts, network.ts, roles.ts, routes.ts
      security.ts, services.ts, usage.ts
    tabs/                  — 20 lazy-loaded tab components
      StatusTab, DevicesTab, MembersTab, ConnectTab, InviteTab, RoutesTab
      IpConfigTab, DerpTab, ServicesTab, BoardTab, FederationTab, CollectivesTab
      TraversalTab, RolesTab, AgentsTab, AclTab, CredentialsTab, UsageTab
      SecurityTab, AuditTab
    lib/
      types.ts             — All shared TypeScript types
      utils.ts             — Utility functions (formatDate, safeUrl, etc.)
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
    types.ts               — Credential type definitions
  identity/
    keys.ts                — Collective key encryption at rest + detached-JWS sign/verify
    account.ts             — Public profile lookup (verified handle, display name, avatar) with no account access
    resolver.ts            — did:web / did:plc resolver (local-collective lookup, SSRF guard, typed multikey decoding, cache)
  federation/
    auth.ts                — CFP message signing/verification, freshness, imported-route filtering
    transport.ts           — Outbound CFP messages over HTTP (CFP-Recipient addressing)
    handshake.ts, protocol.ts, session.ts, route-engine.ts, scoping.ts — CFP state machines and types
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
    boards.ts              — Controller board, public board (service posts, approval, Connect), private board, access mode
    sharing.ts             — Friends, blocks and device shares between members
    agents.ts              — Agent token CRUD (create, list, revoke)
    acl.ts                 — ACL policy GET/PUT (manage_acl permission, Zod-validated)
    derp.ts                — Custom DERP relay management (regions, embedded toggle, public relay toggle)
    ip-config.ts           — Per-tenant IP range configuration (v4/v6 prefixes, allocation strategy)
    routes.ts              — Exit node and subnet router management (enable/disable/delete routes)
    usage.ts               — Usage metering (live counts + snapshot history)
    federation.ts          — Federation link CRUD (request/accept/reject/revoke between tailnets), collective DID + discovery documents
    federation-messages.ts — Inbound CFP endpoints (hello/commit/keepalive/revoke), DID-signature authenticated
    credentials.ts         — VC-JWT issuance, public verify, holder-binding challenges, revocation, service-auth presentation
    dashboard.ts           — HTML shell serving React SPA bundles (dashboard + join page)
    helpers.ts             — Shared middleware, param(), permission checks, agent token resolution, hs username/URL helpers
    audit.ts               — Fire-and-forget audit log writer
docs/adr/                  — Architecture Decision Records (0001-0024)
BUILD_PLAN.md              — Phased build tracker
coordinator/               — Rust mesh coordinator workspace
  crates/
    coord-core/            — TenantId, NodeId, ControlKey, MachineKey, error types
    coord-noise/           — Noise IK handshake + encrypted transport (snow-based)
    coord-proto/           — Tailscale control protocol messages (RegisterRequest/Response, MapRequest/Response)
    coord-acl/             — ACL policy engine (trait)
    coord-store/           — Storage backends: MemoryStore, PgStore, SqliteStore (sqlx)
    coord-api/             — REST management API (axum)
    coord-federation/      — Federation broker: protocol types, session lifecycle, route engine, abuse/scoping, handshake state machine, auth, transport, discovery, store trait + PgFederationStore/SqliteFederationStore/FederationMemoryStore, broker service, inbound handlers
    coord-server/          — Binary entrypoint
```
