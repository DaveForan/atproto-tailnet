/**
 * @module helpers
 *
 * Shared middleware and utility functions used across all route modules.
 *
 * - {@link requireAuth} — rejects unauthenticated requests (session or Bearer token)
 * - {@link param} — normalises Express 5 route params to a plain string
 * - {@link getTenantForUser} — loads tenant + membership + role in one query
 * - {@link hasPermission} — checks a permission against role (+ agent token scope)
 * - {@link isLockedDown} — returns true when the tenant is in lockdown
 * - {@link toHsUsername} / {@link tenantLoginServer} — Headscale naming helpers
 * - {@link resolveAgentToken} — Bearer token → agent context (or MCP user) middleware
 */

import { createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { eq, and, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants, memberships, roles, agentTokens, users, deviceLocks } from "../db/schema.js";
import { tenantPublicUrl } from "../config.js";
import type { Permission } from "./permissions.js";
import { oauthProvider, isMcpToken, MCP_RESOURCE_URL } from "../oauth/index.js";
import { sameResource } from "../oauth/provider.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

/**
 * Express middleware that resolves a Bearer token from the `Authorization`
 * header. If present and valid, populates `req.agentToken` so downstream
 * handlers work transparently via {@link authUserId}.
 *
 * Does NOT write to `req.session` — agent auth is stateless and must not
 * persist a session cookie. Also verifies the tenant's `allowAgentTokens`
 * and `allowMemberAgentTokens` settings at runtime.
 *
 * Must be mounted **before** `requireAuth` in the middleware chain.
 */
export async function resolveAgentToken(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    next();
    return;
  }

  const raw = authHeader.slice(7);

  // MCP OAuth access tokens (`mcp_…`) authenticate the request AS THE USER:
  // req.mcpAuth is set, req.agentToken stays unset, so agent-token scope and
  // restrictions never apply. Invalid/expired/revoked tokens (or a disabled
  // user) leave the request unauthenticated.
  if (isMcpToken(raw)) {
    try {
      const info = await oauthProvider.verifyAccessToken(raw);
      const extra = info.extra as { userId: string; grantId: string };
      // Audience check: only tokens issued for this server's /mcp resource.
      if (info.resource && sameResource(info.resource.href, MCP_RESOURCE_URL)) {
        req.mcpAuth = { userId: extra.userId, clientId: info.clientId, grantId: extra.grantId };
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

  // Verify the tenant still allows agent tokens
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

  // Check member token toggle for non-originator tokens
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

  // Touch lastUsedAt (fire-and-forget)
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
 * Express middleware that enforces agent token tenant scoping.
 *
 * If the request carries an agent token and the URL contains a tenant UUID
 * (the standard `/api/tenants/:uuid/...` pattern), the token's tenantId
 * must match. Rejects with 403 on mismatch. Mount after
 * {@link resolveAgentToken} in the middleware chain.
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
  const m = req.path.match(
    /\/api\/tenants\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  if (m) {
    if (m[1] !== req.agentToken.tenantId) {
      res.status(403).json({ error: "Agent token is scoped to a different tenant" });
      return;
    }
  } else {
    // Block non-tenant-scoped routes to prevent cross-tenant data leaks.
    // Only /api/me and /api/permissions are allowed without a tenant UUID.
    const allowed = ["/api/me", "/api/permissions", "/api/tenants", "/health"];
    if (!allowed.includes(req.path)) {
      res.status(403).json({ error: "Agent tokens cannot access non-tenant-scoped routes" });
      return;
    }
  }
  next();
}

/**
 * Rejects unauthenticated requests with 401.
 *
 * Works with both session-based auth (cookie) and agent token auth
 * (Bearer header resolved by {@link resolveAgentToken}).
 */
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

/**
 * Returns the authenticated user's ID from the agent token, the MCP OAuth
 * token or the session (a Bearer credential wins over a cookie).
 * Must be called after {@link requireAuth}.
 */
export function authUserId(req: Request): string {
  return req.agentToken?.userId ?? req.mcpAuth?.userId ?? req.session.userId!;
}

/**
 * Returns the authenticated user's DID. For session-based auth, reads from
 * the session. For agent/MCP tokens, looks up the DID from the users table.
 */
export async function authUserDid(req: Request): Promise<string | null> {
  if (req.session.did && !req.agentToken && !req.mcpAuth) return req.session.did;
  const userId = authUserId(req);
  const [user] = await db
    .select({ did: users.did })
    .from(users)
    .where(eq(users.id, userId));
  return user?.did ?? null;
}

/**
 * Extracts a named route param, normalising Express 5's
 * `string | string[]` return type to a plain string.
 */
export function param(req: Request, name: string): string {
  const val = req.params[name];
  if (Array.isArray(val)) return val[0];
  return val;
}

/** Result of {@link getTenantForUser}: tenant row, membership row, and resolved role (nullable). */
export type TenantForUser = {
  tenant: typeof tenants.$inferSelect;
  membership: typeof memberships.$inferSelect;
  role: typeof roles.$inferSelect | null;
};

const ACTIVITY_DEBOUNCE_MS = 5 * 60 * 1000;

/**
 * Loads a tenant + the caller's membership + their role in one query.
 * Also touches `lastActivityAt` (debounced to once per 5 minutes).
 *
 * Returns `null` if the user is not a member **or** the tenant is soft-deleted.
 */
export async function getTenantForUser(
  tenantId: string,
  userId: string,
): Promise<TenantForUser | null> {
  const results = await db
    .select({ tenant: tenants, membership: memberships, role: roles })
    .from(memberships)
    .innerJoin(tenants, eq(memberships.tenantId, tenants.id))
    .leftJoin(roles, eq(memberships.roleId, roles.id))
    .where(
      and(
        eq(memberships.tenantId, tenantId),
        eq(memberships.userId, userId),
        ne(tenants.status, "deleted"),
      ),
    );

  const result = results[0] ?? null;

  if (result) {
    const sinceActivity = Date.now() - result.tenant.lastActivityAt.getTime();
    if (sinceActivity > ACTIVITY_DEBOUNCE_MS) {
      db.update(tenants)
        .set({ lastActivityAt: new Date() })
        .where(eq(tenants.id, tenantId))
        .catch(() => {});
    }
  }

  return result;
}

/**
 * Checks whether a membership has a specific permission.
 *
 * - Originators implicitly have all permissions.
 * - Others check their role's JSONB permissions array.
 * - If the request was made via an agent token, the permission must also
 *   appear in the token's scoped permissions list.
 *
 * @param req - Optional Express request; when provided, agent token scope
 *              is checked. Pass `undefined` to skip token scoping.
 */
export function hasPermission(
  membership: typeof memberships.$inferSelect,
  role: typeof roles.$inferSelect | null,
  permission: Permission,
  req?: Request,
): boolean {
  if (membership.isOriginator && !req?.agentToken) return true;

  // Agent tokens constrain even originators to their scoped permissions
  if (req?.agentToken) {
    if (!(req.agentToken.permissions as string[]).includes(permission)) {
      return false;
    }
    if (membership.isOriginator) return true;
  }

  if (!role) return false;
  const perms = role.permissions as string[];
  return perms.includes(permission);
}

/**
 * Returns the subset of `permissions` the caller does NOT effectively hold
 * (role permissions ∩ agent-token scope, originators = all — same rules as
 * {@link hasPermission}). Used to stop privilege escalation via role
 * create/edit/assign: a caller may only grant permissions they hold.
 */
export function missingPermissions(
  membership: typeof memberships.$inferSelect,
  role: typeof roles.$inferSelect | null,
  permissions: readonly string[],
  req: Request,
): string[] {
  return permissions.filter(
    (p) => !hasPermission(membership, role, p as Permission, req),
  );
}

/**
 * True when the given user's membership in the tenant is bound by a device
 * lock — no new pre-auth keys may be minted for them until it is removed.
 */
export async function isDeviceLocked(tenantId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: deviceLocks.id })
    .from(deviceLocks)
    .innerJoin(memberships, eq(deviceLocks.membershipId, memberships.id))
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

/** Message returned when key generation is blocked by a device lock. */
export const DEVICE_LOCKED_ERROR =
  "Session is locked to specific devices. Remove lock to add new devices.";

/** Returns true when the tenant is in lockdown mode. */
export function isLockedDown(
  tenant: typeof tenants.$inferSelect,
): boolean {
  return tenant.lockdownMode;
}

/** Converts an AT Proto handle to a Headscale-safe username (lowercase alphanumeric + hyphens). */
export function toHsUsername(handle: string): string {
  return handle
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

/** Builds the login-server URL for a tenant slug (e.g. `https://my-tenant.ts.example.com`). */
export function tenantLoginServer(slug: string): string {
  return tenantPublicUrl(slug);
}
