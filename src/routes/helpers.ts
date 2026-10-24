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
 * - {@link resolveAgentToken} — Bearer token → agent context middleware
 */

import { createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { eq, and, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants, memberships, roles, agentTokens } from "../db/schema.js";
import { config } from "../config.js";
import type { Permission } from "./permissions.js";

/**
 * Express middleware that resolves a Bearer token from the `Authorization`
 * header. If present and valid, populates `req.session.userId` and
 * `req.agentToken` so downstream handlers work transparently.
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

  // Touch lastUsedAt (fire-and-forget)
  db.update(agentTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(agentTokens.id, token.id))
    .catch(() => {});

  req.session.userId = token.userId;
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
  if (m && m[1] !== req.agentToken.tenantId) {
    res.status(403).json({ error: "Agent token is scoped to a different tenant" });
    return;
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
  if (!req.session.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  next();
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

/**
 * Loads a tenant + the caller's membership + their role in one query.
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

  return results[0] ?? null;
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
  const proto = config.publicUrl.startsWith("https") ? "https" : "http";
  return `${proto}://${slug}.${config.baseDomain}`;
}
