import type { Request, Response, NextFunction } from "express";
import { eq, and, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants, memberships, roles } from "../db/schema.js";
import { config } from "../config.js";
import type { Permission } from "./permissions.js";

/** Rejects unauthenticated requests with 401. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  next();
}

/** Extracts a named route param, normalising Express 5's string|string[] to string. */
export function param(req: Request, name: string): string {
  const val = req.params[name];
  if (Array.isArray(val)) return val[0];
  return val;
}

export type TenantForUser = {
  tenant: typeof tenants.$inferSelect;
  membership: typeof memberships.$inferSelect;
  role: typeof roles.$inferSelect | null;
};

/** Loads a tenant + the caller's membership + their role in one query. Returns null if not a member. */
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
 * Originators implicitly have all permissions. Others check their role's JSONB array.
 */
export function hasPermission(
  membership: typeof memberships.$inferSelect,
  role: typeof roles.$inferSelect | null,
  permission: Permission,
): boolean {
  if (membership.isOriginator) return true;
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

/** Converts an AT Proto handle to a Headscale-safe username. */
export function toHsUsername(handle: string): string {
  return handle
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

/** Builds the login-server URL for a tenant slug. */
export function tenantLoginServer(slug: string): string {
  const proto = config.publicUrl.startsWith("https") ? "https" : "http";
  return `${proto}://${slug}.${config.baseDomain}`;
}
