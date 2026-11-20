/**
 * @module members/cascade
 * Member removal: everything a member leaves behind in one tailnet (devices,
 * keys, machine lock, approvals, posts, services, access state, membership).
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  tenants,
  memberships,
  users,
  deviceApprovals,
  serviceDevices,
  services,
  boardPosts,
} from "../db/schema.js";
import { getControlClient, getCoordinatorClient, useCoordinator } from "../orchestrator/control-client.js";
import { toHsUsername } from "../identity/handles.js";
import { revokeMemberAccess } from "../access/keys.js";
import { removeMemberAccessState } from "../access/devices.js";
import { syncTenantAccess } from "../access/sync.js";
import { logger } from "../logger.js";

/**
 * The kick cascade: revoke the member's keys and delete their devices (both
 * control-plane modes), reject their pending device approvals, remove their
 * board posts, services and service devices, then delete the membership.
 * Callers do the permission/originator checks and the audit entry. Shared by
 * the kick route (routes/devices.ts) and the operator "disable user" action.
 */
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

  // Remove their devices and revoke their keys (both control-plane modes)
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
    // Their machine lock in this tailnet goes with them (ADR-0035)
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

  // Soft-delete board posts by this user
  await db
    .update(boardPosts)
    .set({ status: "removed", updatedAt: new Date() })
    .where(
      and(
        eq(boardPosts.tenantId, tenantId),
        eq(boardPosts.authorId, removedUserId),
        eq(boardPosts.status, "active"),
      ),
    );

  // Remove services owned by this user (board posts already cleaned above)
  const userServices = await db
    .select({ id: services.id })
    .from(services)
    .where(and(eq(services.tenantId, tenantId), eq(services.ownerId, removedUserId)));
  for (const svc of userServices) {
    await db
      .update(boardPosts)
      .set({ status: "removed", updatedAt: new Date() })
      .where(and(eq(boardPosts.serviceId, svc.id), eq(boardPosts.status, "active")));
    await db.delete(services).where(eq(services.id, svc.id));
  }

  // Remove service devices owned by this user
  await db
    .delete(serviceDevices)
    .where(and(eq(serviceDevices.tenantId, tenantId), eq(serviceDevices.ownerId, removedUserId)));

  // Posts, connections, friendships and shares of the member (ADR-0036)
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
