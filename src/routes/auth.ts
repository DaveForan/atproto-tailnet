/**
 * @module routes/auth
 * AT Protocol OAuth login/callback/logout and .well-known endpoint serving.
 * Also handles first-login tenant provisioning (async via setImmediate).
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { eq } from "drizzle-orm";
import {
  getOAuthClient,
  getClientMetadata,
  getPublicJwks,
  OAUTH_SCOPE,
} from "../auth/atproto.js";
import { fetchAccountProfile } from "../identity/account.js";
import { db } from "../db/index.js";
import { users, tenants, memberships, roles } from "../db/schema.js";
import { allocateTenantPort } from "../orchestrator/ports.js";
import { adoptInstance, createInstance } from "../orchestrator/headscale.js";
import { syncTenantRoutes } from "../orchestrator/caddy.js";
import { getControlClient, useCoordinator } from "../orchestrator/control-client.js";
import { CoordinatorApiClient } from "../orchestrator/coordinator-api.js";
import {
  ORIGINATOR_PERMISSIONS,
  DEFAULT_CITIZEN_PERMISSIONS,
} from "./permissions.js";
import { logger } from "../logger.js";
import { canCreateTailnet, claimDefaultTailnet, withTailnetCreationLock } from "../operator/policy.js";
import {
  generateAvailableFriendlyName,
  generateInternalSlug,
  hostnameAvailableFor,
  registerInitialHostname,
} from "../orchestrator/hostnames.js";

/** Static page for a disabled account's sign-in attempt (no scripts — CSP-safe). */
const ACCOUNT_DISABLED_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Account disabled — atproto-tailnet</title>
  <link rel="stylesheet" href="/css/dashboard.css" />
</head>
<body>
  <main class="container">
    <h1>Account disabled</h1>
    <p>Your account has been disabled by the operator of this instance, so you can't sign in.</p>
    <p>If you think this is a mistake, contact the instance operator.</p>
    <p><a href="/">Back to the home page</a></p>
  </main>
</body>
</html>`;

/** Shown when the account's handle cannot be verified from public sources. */
const HANDLE_UNVERIFIED_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign-in failed — atproto-tailnet</title>
  <link rel="stylesheet" href="/css/dashboard.css" />
</head>
<body>
  <main class="container">
    <h1>Sign-in could not be completed</h1>
    <p>Your account was identified, but its handle could not be verified right now. Try again in a few minutes.</p>
    <p><a href="/">Back to the home page</a></p>
  </main>
</body>
</html>`;

/** Shown when an OAuth callback arrives in a browser that did not start it. */
const LOGIN_MISMATCH_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign-in expired — atproto-tailnet</title>
  <link rel="stylesheet" href="/css/dashboard.css" />
</head>
<body>
  <main class="container">
    <h1>Sign-in could not be completed</h1>
    <p>This sign-in link was not started in this browser, or it has expired. Start again from the home page.</p>
    <p><a href="/">Back to the home page</a></p>
  </main>
</body>
</html>`;

/** Sign-ins a browser may have in flight at once (one nonce each). */
const MAX_PENDING_LOGIN_NONCES = 5;

/**
 * `Sec-Fetch-Site` values allowed to start a sign-in: our own pages
 * (`same-origin`), a typed URL or bookmark (`none`), or an old browser that
 * sends no header.
 */
export function loginFetchSiteAllowed(value: string | string[] | undefined): boolean {
  if (value === undefined) return true;
  return value === "same-origin" || value === "none";
}

/**
 * True only when the browser session holds a login nonce and the OAuth state
 * returned by the callback is that same nonce (constant-time compare).
 */
export function loginNonceMatches(expected: string | undefined, actual: string | null | undefined): boolean {
  if (!expected || !actual) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Router for authentication routes: login initiation, OAuth callback,
 * logout, and AT Proto .well-known metadata/JWKS endpoints.
 */
export const authRouter = Router();

/**
 * Opaque internal id for a new tailnet. Never derived from the handle: the id
 * is the coordinator's tenant slug and is part of the collective DID, so a
 * handle-based id would reveal who runs which tailnet.
 */
async function generateUniqueSlug(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const candidate = generateInternalSlug();
    if (await hostnameAvailableFor(candidate, "")) return candidate;
  }
  throw new Error("Could not generate unique slug");
}

/**
 * Creates a top-level tenant owned by `user` (roles, originator membership)
 * and provisions its control plane asynchronously. Callers must have checked
 * {@link canCreateTailnet}. The first operator tailnet becomes the instance
 * default (with join requests on) when no default is set.
 */
export async function provisionTenant(
  user: typeof users.$inferSelect,
  displayName: string,
  handle: string,
  opts: { name?: string } = {},
): Promise<typeof tenants.$inferSelect> {
  const { allocateTenantPrefixes } = await import("../orchestrator/prefix-allocator.js");
  const prefixes = await allocateTenantPrefixes();

  let tenant: typeof tenants.$inferSelect | undefined;
  let slug = "";
  let port = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    // Re-derive both unique values on every attempt (either can race)
    slug = await generateUniqueSlug();
    // Coordinator-mode tenants have no Headscale container, so they get a
    // synthetic placeholder instead of consuming a real port from the range.
    port = await allocateTenantPort(!useCoordinator);
    try {
      const [inserted] = await db
        .insert(tenants)
        .values({
          slug,
          name: opts.name ?? `${displayName}'s tailnet`,
          ownerUserId: user.id,
          port,
          apiKey: "",
          status: "provisioning",
          ipv4Prefix: prefixes.ipv4Prefix,
          ipv6Prefix: prefixes.ipv6Prefix,
        })
        .returning();
      tenant = inserted;
      break;
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (attempt === 2 || pgErr.code !== "23505") throw err;
    }
  }
  if (!tenant) throw new Error("Failed to create tenant after retries");
  // Public address: a random friendly name the originator is asked to change
  // in the setup wizard. The internal slug is never routed publicly.
  await registerInitialHostname(tenant.id, await generateAvailableFriendlyName());

  // Create system roles
  const [originatorRole] = await db
    .insert(roles)
    .values({
      tenantId: tenant.id,
      name: "originator",
      description: "Full control over the tailnet",
      permissions: [...ORIGINATOR_PERMISSIONS],
      isSystem: true,
    })
    .returning();

  const [citizenRole] = await db
    .insert(roles)
    .values({
      tenantId: tenant.id,
      name: "citizen",
      description: "Default role for new members",
      permissions: [...DEFAULT_CITIZEN_PERMISSIONS],
      isSystem: true,
    })
    .returning();

  // Set citizen as the default role for new members
  await db
    .update(tenants)
    .set({ defaultRoleId: citizenRole.id })
    .where(eq(tenants.id, tenant.id));

  // Create originator membership
  await db.insert(memberships).values({
    userId: user.id,
    tenantId: tenant.id,
    role: "owner",
    roleId: originatorRole.id,
    isOriginator: true,
  });

  try {
    await claimDefaultTailnet(tenant.id, user.did);
  } catch (err) {
    logger.error({ tenantId: tenant.id, err }, "failed to claim default tailnet");
  }

  setImmediate(() => {
    void provisionTenantInstance(tenant!.id, slug, port);
  });
  return tenant;
}

/**
 * Bring a tenant's control-plane instance up and mark the tenant running.
 *
 * In coordinator mode: creates the tenant in the Rust coordinator via REST,
 * stores the coordinator-side tenant UUID, sets default policy.
 *
 * In Headscale mode: starts a Docker container (or adopts a leftover one),
 * stores its API key, installs the default ACL policy.
 *
 * Both modes sync Caddy routes at the end. On failure the tenant is marked "error".
 * Sub-collectives pass the parent's coordinator tenant id so the coordinator
 * knows the hierarchy (route aggregation, federation posture).
 */
export async function provisionTenantInstance(
  tenantId: string,
  slug: string,
  port: number,
  opts: { parentCoordinatorTenantId?: string | null } = {},
): Promise<boolean> {
  try {
    if (useCoordinator) {
      await provisionViaCoordinator(tenantId, slug, port, opts.parentCoordinatorTenantId ?? null);
    } else {
      await provisionViaHeadscale(tenantId, slug, port);
    }

    await syncTenantRoutes().catch((err) =>
      logger.error({ tenantSlug: slug, err }, "failed to sync Caddy routes"),
    );

    logger.info({ tenantSlug: slug, port, mode: useCoordinator ? "coordinator" : "headscale" }, "tenant provisioned");
    return true;
  } catch (err) {
    logger.error({ tenantSlug: slug, err }, "failed to provision tenant");
    await db
      .update(tenants)
      .set({ status: "error", updatedAt: new Date() })
      .where(eq(tenants.id, tenantId));
    return false;
  }
}

/** Sentinel value stored in apiKey for coordinator-mode tenants. */
const COORDINATOR_API_KEY_SENTINEL = "__coordinator__";

async function provisionViaCoordinator(
  tenantId: string,
  slug: string,
  _port: number,
  parentCoordinatorTenantId: string | null,
): Promise<void> {
  const { config } = await import("../config.js");
  const coordUrl = config.coordinatorUrl!;

  const res = await fetch(`${coordUrl}/api/tenants`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.coordinatorApiKey
        ? { Authorization: `Bearer ${config.coordinatorApiKey}` }
        : {}),
    },
    body: JSON.stringify(
      parentCoordinatorTenantId ? { slug, parent_id: parentCoordinatorTenantId } : { slug },
    ),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Coordinator tenant creation failed (${res.status}): ${text}`);
  }

  const coordTenant = (await res.json()) as { id: string };

  try {
    await db
      .update(tenants)
      .set({
        coordinatorTenantId: coordTenant.id,
        apiKey: COORDINATOR_API_KEY_SENTINEL,
        status: "running",
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, tenantId));

    const client = getControlClient({
      port: 0,
      apiKey: COORDINATOR_API_KEY_SENTINEL,
      coordinatorTenantId: coordTenant.id,
    });

    // Default allow-all, translated to the coordinator's {default_deny, rules} model
    const defaultPolicy = {
      acls: [{ action: "accept", src: ["*"], dst: ["*:*"] }],
    };
    if (client instanceof CoordinatorApiClient) {
      await client.setHeadscalePolicy(defaultPolicy);
    } else {
      await client.setPolicy(defaultPolicy);
    }
  } catch (err) {
    // Compensating delete — best effort
    try {
      await fetch(`${coordUrl}/api/tenants/${coordTenant.id}`, {
        method: "DELETE",
        headers: config.coordinatorApiKey
          ? { Authorization: `Bearer ${config.coordinatorApiKey}` }
          : {},
      });
    } catch {
      // Best-effort cleanup; log the original error
    }
    throw err;
  }
}

async function provisionViaHeadscale(
  tenantId: string,
  slug: string,
  port: number,
): Promise<void> {
  const instance =
    (await adoptInstance(slug, port)) ?? (await createInstance(slug, port));

  await db
    .update(tenants)
    .set({
      apiKey: instance.apiKey,
      containerId: instance.containerId,
      status: "running",
      updatedAt: new Date(),
    })
    .where(eq(tenants.id, tenantId));

  const client = getControlClient({
    port,
    apiKey: instance.apiKey,
  });

  await client.setPolicy({
    acls: [{ action: "accept", src: ["*"], dst: ["*:*"] }],
  });
}

authRouter.get("/auth/login", async (req, res) => {
  try {
    // Forced-login CSRF: sign-in only starts from our own pages (or a typed
    // URL). A cross-site link could otherwise start a flow against an
    // attacker's auto-approving PDS and sign the victim in as the attacker.
    if (!loginFetchSiteAllowed(req.headers["sec-fetch-site"])) {
      res.status(403).type("html").send(LOGIN_MISMATCH_HTML);
      return;
    }

    const handle = req.query.handle as string;
    if (!handle) {
      res.status(400).json({ error: "handle query parameter required" });
      return;
    }

    const redirect = req.query.redirect as string | undefined;
    if (redirect && /^\/[a-z0-9]/.test(redirect)) {
      req.session.postLoginRedirect = redirect;
    }

    // Bind this OAuth flow to this browser: the callback only completes in the
    // session that started it, so a callback URL cannot be replayed in another
    // browser to sign it in as someone else (login CSRF).
    // A few nonces are kept so sign-ins started in parallel tabs all complete.
    const loginNonce = randomBytes(32).toString("hex");
    req.session.oauthLoginNonces = [...(req.session.oauthLoginNonces ?? []), loginNonce].slice(
      -MAX_PENDING_LOGIN_NONCES,
    );

    const client = await getOAuthClient();
    const url = await client.authorize(handle, {
      scope: OAUTH_SCOPE,
      state: loginNonce,
    });

    req.session.save((err) => {
      if (err) {
        logger.error({ err }, "session save failed before login redirect");
        res.status(500).json({ error: "Failed to initiate login" });
        return;
      }
      res.redirect(url.toString());
    });
  } catch (err) {
    logger.error({ err }, "login initiation failed");
    res.status(500).json({ error: "Failed to initiate login" });
  }
});

authRouter.get("/auth/callback", async (req, res) => {
  try {
    const client = await getOAuthClient();
    const params = new URLSearchParams(req.url.split("?")[1]);
    const pendingNonces = req.session.oauthLoginNonces ?? [];
    const { session, state } = await client.callback(params);
    const matched = pendingNonces.find((n) => loginNonceMatches(n, state));
    // The callback proved who the account is; that is all sign-in is for.
    // Revoke the tokens right away so the service never holds account access.
    await session.signOut().catch((err) => logger.warn({ err }, "failed to revoke OAuth session after sign-in"));
    if (!matched) {
      logger.warn({ did: session.did }, "OAuth callback refused: not started in this browser");
      res.status(400).type("html").send(LOGIN_MISMATCH_HTML);
      return;
    }
    req.session.oauthLoginNonces = pendingNonces.filter((n) => n !== matched);

    const did = session.did;

    let [user] = await db.select().from(users).where(eq(users.did, did));

    // Profile details come from public sources — no account access is used.
    const profile = await fetchAccountProfile(did);
    const handle = profile.handle ?? user?.handle;
    if (!handle) {
      logger.warn({ did }, "sign-in refused: handle could not be verified");
      res.status(502).type("html").send(HANDLE_UNVERIFIED_HTML);
      return;
    }
    const displayName = profile.displayName ?? user?.displayName ?? handle;
    const avatarUrl = profile.avatarUrl ?? user?.avatarUrl ?? null;

    if (user?.disabledAt) {
      logger.info({ did }, "sign-in refused: account disabled");
      req.session.destroy(() => {
        res.status(403).type("html").send(ACCOUNT_DISABLED_HTML);
      });
      return;
    }

    if (!user) {
      [user] = await db
        .insert(users)
        .values({ did, handle, displayName, avatarUrl })
        .returning();
    } else {
      await db
        .update(users)
        .set({ handle, displayName, avatarUrl, updatedAt: new Date() })
        .where(eq(users.id, user.id));
    }

    // A user with no membership gets their own tailnet only if they may create
    // one (operator / designated creator, single-tailnet rule). Everyone else
    // lands on the dashboard's no-access view (invitations, join request).
    // Also covers a first-login provisioning failure after the user row was
    // inserted. Users with any membership are left alone.
    await withTailnetCreationLock(async () => {
      const [anyMembership] = await db
        .select({ id: memberships.id })
        .from(memberships)
        .where(eq(memberships.userId, user.id))
        .limit(1);
      if (!anyMembership && (await canCreateTailnet(user))) {
        await provisionTenant(user, displayName, handle);
      }
    });

    const dest = req.session.postLoginRedirect || "/";
    req.session.regenerate((err) => {
      if (err) {
        logger.error({ err }, "session regeneration failed");
        res.status(500).json({ error: "Authentication failed" });
        return;
      }
      req.session.userId = user.id;
      req.session.did = did;
      req.session.save((err) => {
        if (err) {
          res.status(500).json({ error: "Session save failed" });
          return;
        }
        res.redirect(dest);
      });
    });
  } catch (err) {
    logger.error({ err }, "OAuth callback failed");
    res.status(500).json({ error: "Authentication failed" });
  }
});

authRouter.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

authRouter.get("/.well-known/atproto-client-metadata.json", (_req, res) => {
  res.json(getClientMetadata());
});

authRouter.get("/.well-known/jwks.json", async (_req, res) => {
  try {
    const jwks = await getPublicJwks();
    res.json(jwks);
  } catch (err) {
    logger.error({ err }, "failed to generate JWKS");
    res.status(500).json({ error: "JWKS not available" });
  }
});
