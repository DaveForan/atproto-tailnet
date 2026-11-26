/**
 * @module helpers
 * Shared route helpers: params, tenant lookup, permission checks, naming. Re-exports request auth.
 */

import type { Request, Response } from "express";
import { eq, and, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants, memberships, roles } from "../db/schema.js";
import { tenantPublicUrl } from "../config.js";
import { ALL_PERMISSIONS, effectivePermissions, type Permission } from "../members/permissions.js";

// Request authentication lives in auth/middleware.ts; routes import it from here.
export {
  resolveAgentToken,
  enforceAgentScope,
  csrfTokenMatches,
  requireAuth,
  requireSession,
} from "../auth/middleware.js";

export { authUserId, authUserDid } from "../auth/request-user.js";

/** A named route param as one string (Express 5 types it `string | string[]`). */
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


/** Tenant, membership and role in one query; null for non-members and deleted tenants. */
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
 * True when the member holds `permission` (originators hold all).
 * Security: pass `req` so an agent token's scope also applies.
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

/** The `permissions` the caller does not hold (agent-token scope included); a caller grants only what they hold. */
export function missingPermissions(
  membership: typeof memberships.$inferSelect,
  role: typeof roles.$inferSelect | null,
  permissions: readonly string[],
  req: Request,
): string[] {
  const held = new Set<string>(effectivePermissions(membership, role, req.agentToken?.permissions));
  return permissions.filter((p) => !held.has(p));
}

/** Permissions of a tenant's role (empty for no role or an unknown id). */
export async function rolePermissions(tenantId: string, roleId: string | null): Promise<string[]> {
  if (!roleId) return [];
  const [row] = await db
    .select({ permissions: roles.permissions })
    .from(roles)
    .where(and(eq(roles.id, roleId), eq(roles.tenantId, tenantId)));
  return (row?.permissions ?? []) as string[];
}

/**
 * Known permissions in `target` that the caller does not hold.
 * Security: a caller may not demote, kick or delete what outranks them.
 */
export function permissionsAbove(
  membership: typeof memberships.$inferSelect,
  role: typeof roles.$inferSelect | null,
  target: readonly string[],
  req: Request,
): string[] {
  const known = ALL_PERMISSIONS as readonly string[];
  return missingPermissions(membership, role, target.filter((p) => known.includes(p)), req);
}

export function isLockedDown(
  tenant: typeof tenants.$inferSelect,
): boolean {
  return tenant.lockdownMode;
}


/** Builds the login-server URL for a tenant slug (e.g. `https://my-tenant.ts.example.com`). */
export function tenantLoginServer(slug: string): string {
  return tenantPublicUrl(slug);
}

/** 502 for a change that the coordinator did not take. The caller saved nothing that claims it. */
export function sendNotApplied(res: Response): void {
  res.status(502).json({ error: "The control server did not take the change. Try again", code: "not_applied" });
}
