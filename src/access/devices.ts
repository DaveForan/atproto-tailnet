/**
 * @module access/devices
 * Device ownership from the control plane and cleanup of a removed member's access state (ADR-0036).
 */

import { isAdmitted } from "./device-holds.js";
import { and, eq, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants, servicePosts, serviceConnections, friendships, memberBlocks, deviceShares } from "../db/schema.js";
import { getCoordinatorClient } from "../orchestrator/control-client.js";

export interface MemberDevice {
  id: string;
  name: string;
  address: string | null;
  online: boolean;
  ownerId: string | null;
}

/**
 * Every admitted device of the tailnet with its owner (our user id).
 * A device that waits for admission has no access, so nothing can select it.
 */
export async function listTenantDevices(tenant: typeof tenants.$inferSelect): Promise<MemberDevice[]> {
  const nodes = await getCoordinatorClient(tenant).listNodes();
  return nodes.filter(isAdmitted).map((n) => ({
    id: String(n.id),
    name: n.givenName || n.name || `device-${n.id}`,
    address: n.ipAddresses?.[0] ?? null,
    online: Boolean(n.online),
    ownerId: n.user?.id != null ? String(n.user.id) : null,
  }));
}

export async function listUserDevices(tenant: typeof tenants.$inferSelect, userId: string): Promise<MemberDevice[]> {
  return (await listTenantDevices(tenant)).filter((d) => d.ownerId === userId);
}

/** Remove everything a member shared, posted or connected in a tailnet (member removed). */
export async function removeMemberAccessState(tenantId: string, userId: string): Promise<void> {
  const posts = await db
    .select({ id: servicePosts.id })
    .from(servicePosts)
    .where(and(eq(servicePosts.tenantId, tenantId), eq(servicePosts.authorId, userId)));
  for (const p of posts) {
    await db.delete(serviceConnections).where(eq(serviceConnections.postId, p.id));
  }
  await db
    .update(servicePosts)
    .set({ status: "removed", updatedAt: new Date() })
    .where(and(eq(servicePosts.tenantId, tenantId), eq(servicePosts.authorId, userId)));
  // The member's own connections to other members' posts in this tailnet
  const tenantPosts = await db
    .select({ id: servicePosts.id })
    .from(servicePosts)
    .where(eq(servicePosts.tenantId, tenantId));
  for (const p of tenantPosts) {
    await db
      .delete(serviceConnections)
      .where(and(eq(serviceConnections.postId, p.id), eq(serviceConnections.userId, userId)));
  }
  await db
    .update(deviceShares)
    .set({ status: "ended", endedAt: new Date() })
    .where(
      and(eq(deviceShares.tenantId, tenantId), or(eq(deviceShares.ownerId, userId), eq(deviceShares.guestId, userId))),
    );
  await db
    .delete(friendships)
    .where(
      and(eq(friendships.tenantId, tenantId), or(eq(friendships.requesterId, userId), eq(friendships.addresseeId, userId))),
    );
  await db
    .delete(memberBlocks)
    .where(
      and(eq(memberBlocks.tenantId, tenantId), or(eq(memberBlocks.blockerId, userId), eq(memberBlocks.blockedId, userId))),
    );
}
