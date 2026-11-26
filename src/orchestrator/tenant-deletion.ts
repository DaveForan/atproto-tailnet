/**
 * @module orchestrator/tenant-deletion
 * Deleting a tailnet (owner delete and operator delete).
 */

import { and, eq, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { invitations, tenants } from "../db/schema.js";
import { syncTenantRoutes } from "./caddy.js";
import { getCoordinatorClient } from "./control-client.js";
import { clearDefaultTailnetIf } from "../operator/policy.js";
import { logger } from "../logger.js";

/** The coordinator refuses to delete a tailnet that has sub-collectives, so callers check first. */
export async function hasLiveChildren(tenantId: string): Promise<boolean> {
  const [child] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(eq(tenants.parentId, tenantId), ne(tenants.status, "deleted")))
    .limit(1);
  return Boolean(child);
}

/** The one refusal body for {@link hasLiveChildren}. */
export const HAS_CHILDREN_REFUSAL = { error: "Delete or detach its sub-collectives first", code: "has_children" } as const;

/**
 * Deletes the tailnet in the coordinator and soft-deletes its row. Callers do authorization and audit.
 * Errors: throws when the coordinator refuses; the row then stays unchanged.
 */
export async function deleteTenantInstance(tenant: typeof tenants.$inferSelect): Promise<void> {
  const tenantId = tenant.id;
  if (tenant.coordinatorTenantId) {
    await getCoordinatorClient(tenant).deleteTenant();
  }

  await db
    .update(tenants)
    .set({ status: "deleted", updatedAt: new Date() })
    .where(eq(tenants.id, tenantId));

  // A deleted tailnet's outstanding invitations can no longer be accepted
  await db
    .update(invitations)
    .set({ status: "revoked", updatedAt: new Date() })
    .where(and(eq(invitations.tenantId, tenantId), eq(invitations.status, "pending")))
    .catch((err: unknown) => logger.warn({ tenantId, err }, "failed to revoke pending invitations"));

  await syncTenantRoutes().catch((err) =>
    logger.error({ tenantSlug: tenant.slug, err }, "failed to sync Caddy routes"),
  );

  await clearDefaultTailnetIf(tenantId).catch((err) =>
    logger.warn({ tenantId, err }, "failed to clear default tailnet"),
  );
}
