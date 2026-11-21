/**
 * @module routes/auth
 * AT Protocol OAuth login, callback and logout, plus the .well-known client documents.
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
import { users, memberships } from "../db/schema.js";
import { logger } from "../logger.js";
import { logAudit } from "../audit/log.js";
import { establishPendingSession, establishSession, trustedDeviceCount } from "../auth/session.js";
import { canCreateTailnet, withTailnetCreationLock } from "../operator/policy.js";
import { provisionTenant } from "../orchestrator/tenant-provisioning.js";

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

/** Instance-level audit row for a sign-in outcome (no tokens or codes in metadata). */
function auditSignIn(userId: string, action: "sign_in_succeeded" | "sign_in_failed", metadata: Record<string, unknown>): void {
  logAudit({ tenantId: null, actorUserId: userId, action, targetType: "user", targetId: userId, metadata });
}

/** Audit a failed sign-in of a known account; an unknown DID has no user row to name. */
async function auditSignInFailure(did: string, reason: string): Promise<void> {
  const [known] = await db.select({ id: users.id }).from(users).where(eq(users.did, did));
  if (known) auditSignIn(known.id, "sign_in_failed", { reason });
}

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

export const authRouter = Router({ caseSensitive: true });

authRouter.get("/auth/login", async (req, res) => {
  try {
    // Forced-login CSRF: sign-in only starts from our own pages (or a typed
    // URL). A cross-site link could otherwise start a flow against an
    // attacker's auto-approving PDS and sign the victim in as the attacker.
    if (!loginFetchSiteAllowed(req.headers["sec-fetch-site"])) {
      res.status(403).type("html").send(LOGIN_MISMATCH_HTML);
      return;
    }

    // Repeated query keys arrive as arrays; only single strings are accepted.
    const handle = req.query.handle;
    if (typeof handle !== "string" || !handle || handle.length > 2048) {
      res.status(400).json({ error: "handle query parameter required" });
      return;
    }

    const redirect = req.query.redirect;
    if (redirect !== undefined && typeof redirect !== "string") {
      res.status(400).json({ error: "redirect must be a single local path" });
      return;
    }
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
      await auditSignInFailure(session.did, "login_not_started_here");
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
      if (user) auditSignIn(user.id, "sign_in_failed", { reason: "handle_unverified" });
      res.status(502).type("html").send(HANDLE_UNVERIFIED_HTML);
      return;
    }
    const displayName = profile.displayName ?? user?.displayName ?? handle;
    const avatarUrl = profile.avatarUrl ?? user?.avatarUrl ?? null;

    if (user?.disabledAt) {
      logger.info({ did }, "sign-in refused: account disabled");
      auditSignIn(user.id, "sign_in_failed", { reason: "account_disabled" });
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

    // A user with no membership gets their own tailnet only if they may create one.
    // Everyone else lands on the dashboard's no-access view (invitations, join request).
    // This also recovers a first-login provisioning failure after the user row insert.
    await withTailnetCreationLock(async () => {
      const [anyMembership] = await db
        .select({ id: memberships.id })
        .from(memberships)
        .where(eq(memberships.userId, user.id))
        .limit(1);
      if (!anyMembership && (await canCreateTailnet(user))) {
        await provisionTenant(user, displayName);
      }
    });

    const dest = req.session.postLoginRedirect || "/";
    // Device lock (ADR-0035): with trusted devices, the account is only
    // identified here. The session stays pending until this browser proves a
    // trusted device; until then it has no access.
    if ((await trustedDeviceCount(user.id)) > 0) {
      await establishPendingSession(req, { userId: user.id, did, redirect: dest });
      auditSignIn(user.id, "sign_in_succeeded", { method: "atproto", devicePending: true });
      res.redirect("/verify-device");
      return;
    }
    await establishSession(req, { userId: user.id, did, atprotoSignIn: true });
    auditSignIn(user.id, "sign_in_succeeded", { method: "atproto", devicePending: false });
    res.redirect(dest);
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
