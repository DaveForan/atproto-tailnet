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
 * - request authentication middleware, re-exported from auth/middleware.ts
 */

import type { Request } from "express";
import { eq, and, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants, memberships, roles } from "../db/schema.js";
import { tenantPublicUrl } from "../config.js";
import { effectivePermissions, type Permission } from "../members/permissions.js";

// Request authentication lives in auth/middleware.ts; routes import it from here.
export {
  resolveAgentToken,
  enforceAgentScope,
  csrfTokenMatches,
  requireAuth,
  requireSession,
} from "../auth/middleware.js";

// authUserId / authUserDid live in auth/request-user.ts (also used by the
// operator guard); re-exported here for route handlers.
export { authUserId, authUserDid } from "../auth/request-user.js";

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
 * The subset of `permissions` the caller does not effectively hold
 * ({@link effectivePermissions} with the agent-token scope). Stops escalation:
 * a caller may only grant permissions they hold.
 */
export function missingPermissions(
  membership: typeof memberships.$inferSelect,
  role: typeof roles.$inferSelect | null,
  permissions: readonly string[],
  req: Request,
): string[] {
  const held = new Set<string>(effectivePermissions(membership, role, req.agentToken?.permissions));
  return permissions.filter((p) => !held.has(p));
}

/** Returns true when the tenant is in lockdown mode. */
export function isLockedDown(
  tenant: typeof tenants.$inferSelect,
): boolean {
  return tenant.lockdownMode;
}

/** Re-exported for route handlers; lives in identity/handles.ts. */
export { toHsUsername } from "../identity/handles.js";

/** Builds the login-server URL for a tenant slug (e.g. `https://my-tenant.ts.example.com`). */
export function tenantLoginServer(slug: string): string {
  return tenantPublicUrl(slug);
}
