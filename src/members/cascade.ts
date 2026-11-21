/** Removes everything a member leaves behind in one tailnet. */

import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  tenants,
  memberships,
  users,
  deviceApprovals,
} from "../db/schema.js";
import { getControlClient, getCoordinatorClient, useCoordinator } from "../orchestrator/control-client.js";
import { toHsUsername } from "../identity/handles.js";
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
  if (removedUser) {
    let client: ReturnType<typeof getControlClient> | null = null;
    if (tenant.apiKey || useCoordinator) {
      try {
        client = getControlClient(tenant);
      } catch (err) {
        logger.error({ tenantId, err }, "no control client for kick cleanup");
      }
    }
    access = await revokeMemberAccess({
      tenantId,
      client,
      userId: removedUserId,
      hsUsername: toHsUsername(removedUser.handle),
    });
    // The member's machine lock in this tailnet goes too (ADR-0035)
    if (useCoordinator && client) {
      await getCoordinatorClient(tenant)
        .deleteOwnerLock(removedUserId)
        .catch((err: unknown) => logger.warn({ tenantId, err }, "failed to remove machine lock of removed member"));
    }
  }

  await db
    .update(deviceApprovals)
    .set({ status: "rejected", reviewedAt: new Date() })
    .where(
      and(
        eq(deviceApprovals.tenantId, tenantId),
        eq(deviceApprovals.requesterId, removedUserId),
        eq(deviceApprovals.status, "pending"),
      ),
    );

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
