/** Removes everything a member leaves behind in one tailnet. */

import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants, memberships, users } from "../db/schema.js";
import { getCoordinatorClient } from "../orchestrator/control-client.js";
import { revokeMemberAccess } from "../access/keys.js";
import { removeMemberAccessState } from "../access/devices.js";
import { syncTenantAccess } from "../access/sync.js";
import { logger } from "../logger.js";

/** Removes a member from a tenant. Callers do the permission checks and write the audit entry. */
export async function removeMemberCascade(
  tenant: typeof tenants.$inferSelect,
  removedUserId: string,
): Promise<{
  removedUser: typeof users.$inferSelect | undefined;
  access: Awaited<ReturnType<typeof revokeMemberAccess>> | null;
}> {
  const tenantId = tenant.id;
  const [removedUser] = await db
    .select()
    .from(users)
    .where(eq(users.id, removedUserId));

  let access: Awaited<ReturnType<typeof revokeMemberAccess>> | null = null;
  // A tailnet that the coordinator does not have yet has no devices and no keys
  if (removedUser && tenant.coordinatorTenantId) {
    const client = getCoordinatorClient(tenant);
    access = await revokeMemberAccess({ tenantId, client, userId: removedUserId });
    // The member's machine lock in this tailnet goes too (ADR-0035)
    await client
      .deleteOwnerLock(removedUserId)
      .catch((err: unknown) => logger.warn({ tenantId, err }, "failed to remove machine lock of removed member"));
  }

  // Removes posts, connections, friendships and shares (ADR-0036)
  await removeMemberAccessState(tenantId, removedUserId);
  await syncTenantAccess(tenantId);

  await db
    .delete(memberships)
    .where(
      and(
        eq(memberships.tenantId, tenantId),
        eq(memberships.userId, removedUserId),
      ),
    );

  return { removedUser, access };
}
