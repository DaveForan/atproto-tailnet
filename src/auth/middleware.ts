/**
 * @module auth/middleware
 * Request authentication: Bearer resolution (agent and MCP tokens), agent
 * token scope, CSRF token comparison and the session/auth gates.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { eq, and } from "drizzle-orm";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { db } from "../db/index.js";
import { tenants, memberships, agentTokens } from "../db/schema.js";
import { oauthProvider, isMcpToken, MCP_RESOURCE_URL } from "../oauth/index.js";
import { sameResource } from "../oauth/provider.js";
import { isInternalMcpCall } from "../mcp/internal.js";

/**
 * Resolves an `Authorization: Bearer` token into `req.agentToken` or `req.mcpAuth`. Mount before `requireAuth`.
 * Stateless: it never writes `req.session`. It checks the tenant's agent-token settings at runtime.
 * Security: an unresolved Bearer header gets 401, never a cookie fallback. CSRF exempts Bearer, so a fallback bypasses it.
 */
export async function resolveAgentToken(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.headers.authorization?.startsWith("Bearer ")) {
    next();
    return;
  }
  let resolved = false;
  await resolveBearer(req, res, () => {
    resolved = true;
  });
  if (!resolved) return; // resolveBearer already sent a response
  if (!req.agentToken && !req.mcpAuth) {
    res
      .status(401)
      .set("WWW-Authenticate", 'Bearer error="invalid_token"')
      .json({ error: "Invalid or expired token" });
    return;
  }
  next();
}

async function resolveBearer(
  req: Request,
  res: Response,
  next: () => void,
): Promise<void> {
  const raw = req.headers.authorization!.slice(7);

  // MCP tokens (`mcp_…`) act AS THE USER: req.mcpAuth is set, so agent-token scope never applies.
  // Invalid, expired or revoked tokens, or a disabled user, leave the request unauthenticated.
  // Security: only loopback calls from our /mcp tools may use them (secret header, see mcp/internal.ts).
  // Elsewhere on the REST API they get 401, so a token's power is exactly the /mcp tool surface.
  if (isMcpToken(raw)) {
    if (!isInternalMcpCall(req)) {
      res
        .status(401)
        .set("WWW-Authenticate", 'Bearer error="invalid_token"')
        .json({ error: "MCP tokens are only valid at the /mcp endpoint" });
      return;
    }
    try {
      const info = await oauthProvider.verifyAccessToken(raw);
      const extra = info.extra as { userId: string; grantId: string; operator?: boolean };
      // Audience check: only tokens issued for this server's /mcp resource.
      if (info.resource && sameResource(info.resource.href, MCP_RESOURCE_URL)) {
        req.mcpAuth = {
          userId: extra.userId,
          clientId: info.clientId,
          grantId: extra.grantId,
          operator: extra.operator === true,
        };
      }
    } catch (err) {
      if (!(err instanceof InvalidTokenError)) throw err;
    }
    next();
    return;
  }

  const hash = createHash("sha256").update(raw).digest("hex");

  const [token] = await db
    .select()
    .from(agentTokens)
    .where(
      and(
        eq(agentTokens.tokenHash, hash),
        eq(agentTokens.status, "active"),
      ),
    );

  if (!token || token.expiresAt < new Date()) {
    next();
    return;
  }

  const [tenant] = await db
    .select({
      allowAgentTokens: tenants.allowAgentTokens,
      allowMemberAgentTokens: tenants.allowMemberAgentTokens,
      ownerUserId: tenants.ownerUserId,
    })
    .from(tenants)
    .where(eq(tenants.id, token.tenantId));

  if (!tenant || !tenant.allowAgentTokens) {
    next();
    return;
  }

  const [membership] = await db
    .select({ isOriginator: memberships.isOriginator })
    .from(memberships)
    .where(
      and(
        eq(memberships.tenantId, token.tenantId),
        eq(memberships.userId, token.userId),
      ),
    );

  if (!membership) {
    next();
    return;
  }

  if (!membership.isOriginator && !tenant.allowMemberAgentTokens) {
    next();
    return;
  }

  db.update(agentTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(agentTokens.id, token.id))
    .catch(() => {});

  req.agentToken = {
    id: token.id,
    tenantId: token.tenantId,
    userId: token.userId,
    permissions: token.permissions as string[],
  };

  next();
}

/**
 * Rejects with 403 an agent token whose tenant differs from the `/api/tenants/:uuid/...` path.
 * Mount after {@link resolveAgentToken}.
 */
export function enforceAgentScope(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.agentToken) {
    next();
    return;
  }
  const path = req.path.toLowerCase();
  const m = path.match(
    /^\/api\/tenants\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/,
  );
  if (m) {
    if (m[1] !== req.agentToken.tenantId.toLowerCase()) {
      res.status(403).json({ error: "Agent token is scoped to a different tenant" });
      return;
    }
  } else {
    // Without a tenant id in the path, only these cross-tenant-safe routes are open
    const allowed = ["/api/me", "/api/permissions", "/api/tenants", "/health"];
    if (!allowed.includes(path)) {
      res.status(403).json({ error: "Agent tokens cannot access non-tenant-scoped routes" });
      return;
    }
  }
  next();
}

/**
 * Constant-time check of the `X-CSRF-Token` header against the session's
 * token. False when either is missing or not a single string.
 */
export function csrfTokenMatches(header: unknown, expected: string | undefined): boolean {
  if (typeof header !== "string" || !header || !expected) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Checks `X-CSRF-Token` on state-changing `/api/*` requests of a cookie session.
 * Bearer requests carry no cookie authority, so they are exempt.
 * Security: the path compares lowercased because Express may match routes case-insensitively.
 */
export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== "POST" && req.method !== "PUT" && req.method !== "PATCH" && req.method !== "DELETE") {
    next();
    return;
  }
  if (!req.path.toLowerCase().startsWith("/api/")) {
    next();
    return;
  }
  if (req.headers.authorization?.startsWith("Bearer ")) {
    next();
    return;
  }
  if (!req.session.userId) {
    next();
    return;
  }
  if (!csrfTokenMatches(req.headers["x-csrf-token"], req.session.csrfToken)) {
    res.status(403).json({ error: "Invalid or missing CSRF token" });
    return;
  }
  next();
}

/** Rejects with 401 a request that has neither a session nor a resolved Bearer credential. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId && !req.agentToken && !req.mcpAuth) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  next();
}

/**
 * Rejects anything but an interactive browser session (no agent token, no MCP
 * token) with 401. For endpoints that manage credentials themselves.
 */
export function requireSession(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId || req.agentToken || req.mcpAuth) {
    res.status(401).json({ error: "Requires a signed-in dashboard session" });
    return;
  }
  next();
}
