import type { Request, Response, NextFunction } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants, memberships } from "../db/schema.js";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  next();
}

export function param(req: Request, name: string): string {
  const val = req.params[name];
  if (Array.isArray(val)) return val[0];
  return val;
}

export async function getTenantForUser(
  tenantId: string,
  userId: string,
): Promise<{
  tenant: typeof tenants.$inferSelect;
  membership: typeof memberships.$inferSelect;
} | null> {
  const results = await db
    .select({ tenant: tenants, membership: memberships })
    .from(memberships)
    .innerJoin(tenants, eq(memberships.tenantId, tenants.id))
    .where(
      and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)),
    );

  return results[0] ?? null;
}
