/**
 * @module orchestrator/tenant-deletion
 * Deleting a tailnet (owner delete and operator delete).
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { invitations, tenants } from "../db/schema.js";
import { destroyInstance } from "./headscale.js";
import { syncTenantRoutes } from "./caddy.js";
import { releaseTenantPort } from "./ports.js";
import { getCoordinatorClient, useCoordinator } from "./control-client.js";
import { clearDefaultTailnetIf } from "../operator/policy.js";
import { logger } from "../logger.js";

/**
 * Tears down a tailnet and soft-deletes its row. Callers do authorization and audit.
 * Errors: throws when the control plane refuses; the row then stays unchanged.
 */
export async function deleteTenantInstance(tenant: typeof tenants.$inferSelect): Promise<void> {
  const tenantId = tenant.id;
  if (tenant.containerId) {
    await destroyInstance(tenant.containerId);
  }

  if (useCoordinator && tenant.coordinatorTenantId) {
    await getCoordinatorClient(tenant).deleteTenant();
  }

  await db
    .update(tenants)
    .set({ status: "deleted", containerId: null, updatedAt: new Date() })
    .where(eq(tenants.id, tenantId));

  // A deleted tailnet's outstanding invitations can no longer be accepted
  await db
    .update(invitations)
    .set({ status: "revoked", updatedAt: new Date() })
    .where(and(eq(invitations.tenantId, tenantId), eq(invitations.status, "pending")))
    .catch((err: unknown) => logger.warn({ tenantId, err }, "failed to revoke pending invitations"));

  // tenants.port is UNIQUE across all rows, so a deleted row must free it
  await releaseTenantPort(tenantId).catch((err) =>
    logger.warn({ tenantId, err }, "failed to release tenant port"),
  );

  await syncTenantRoutes().catch((err) =>
    logger.error({ tenantSlug: tenant.slug, err }, "failed to sync Caddy routes"),
  );

  await clearDefaultTailnetIf(tenantId).catch((err) =>
    logger.warn({ tenantId, err }, "failed to clear default tailnet"),
  );
}
