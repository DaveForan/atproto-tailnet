/**
 * @module access/sync
 * Compiles a tailnet's access state and pushes it to the coordinator (ADR-0036).
 * Call after every change to posts, connections, shares or the access mode.
 */

import { and, eq, inArray, lt, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants, servicePosts, serviceConnections, deviceShares, memberships } from "../db/schema.js";
import { config } from "../config.js";
import { getCoordinatorClient } from "../orchestrator/control-client.js";
import { logger } from "../logger.js";
import {
  compileAccess,
  compileDns,
  connectionsAllowedByRole,
  findStaleAccess,
  type MemberRole,
  type AccessMode,
  type CoordinatorAccess,
  type CoordinatorDns,
  type StaleAccess,
} from "./compiler.js";
import { primaryHostname } from "../orchestrator/hostnames.js";
import { notifyUser } from "../notifications/service.js";

/** Why a post, connection or share ended because its device changed owner. */
export const OWNER_CHANGED_REASON = "The device now belongs to another member";

/**
 * Closes what a device's change of owner made stale (see `findStaleAccess`).
 * The result is persisted, so access stays closed if the device returns to its first owner.
 */
export async function closeStaleAccess(tenantId: string, nodeOwners: ReadonlyMap<string, string>): Promise<StaleAccess> {
  const posts = await db
    .select()
    .from(servicePosts)
    .where(and(eq(servicePosts.tenantId, tenantId), ne(servicePosts.status, "removed")));
  const postIds = posts.map((p) => p.id);
  const connections = postIds.length
    ? await db.select().from(serviceConnections).where(inArray(serviceConnections.postId, postIds))
    : [];
  const shares = await db
    .select()
    .from(deviceShares)
    .where(and(eq(deviceShares.tenantId, tenantId), ne(deviceShares.status, "ended")));
  const stale = findStaleAccess({ posts, connections, shares, nodeOwners });
  const now = new Date();

  for (const id of stale.postIds) {
    const post = posts.find((p) => p.id === id)!;
    await db.delete(serviceConnections).where(eq(serviceConnections.postId, id));
    await db
      .update(servicePosts)
      .set({ status: "rejected", rejectReason: OWNER_CHANGED_REASON, reviewedById: null, reviewedAt: now, updatedAt: now })
      .where(and(eq(servicePosts.id, id), ne(servicePosts.status, "removed")));
    notifyUser(tenantId, post.authorId, "service_post_rejected", {
      title: "Your service post was withdrawn",
      body: `"${post.title}": ${OWNER_CHANGED_REASON.toLowerCase()}.`,
      link: "/#board",
    });
  }
  for (const c of stale.connections) {
    if (stale.postIds.includes(c.postId)) continue;
    await db
      .delete(serviceConnections)
      .where(and(eq(serviceConnections.postId, c.postId), eq(serviceConnections.nodeId, c.nodeId)));
  }
  for (const id of stale.shareIds) {
    const share = shares.find((x) => x.id === id)!;
    const ended = await db
      .update(deviceShares)
      .set({ status: "ended", endedAt: now })
      .where(and(eq(deviceShares.id, id), ne(deviceShares.status, "ended")))
      .returning({ id: deviceShares.id });
    if (ended.length === 0) continue;
    for (const userId of [share.ownerId, share.guestId]) {
      notifyUser(tenantId, userId, "share_ended", {
        title: "A device share ended",
        body: `${OWNER_CHANGED_REASON}.`,
        link: "/#sharing",
      });
    }
  }
  for (const g of stale.guestNodes) {
    await db
      .update(deviceShares)
      .set({ guestNodeIds: g.keep })
      .where(and(eq(deviceShares.id, g.shareId), ne(deviceShares.status, "ended")));
  }
  const total = stale.postIds.length + stale.connections.length + stale.shareIds.length + stale.guestNodes.length;
  if (total > 0) {
    logger.warn(
      {
        tenantId,
        posts: stale.postIds.length,
        connections: stale.connections.length,
        shares: stale.shareIds.length,
        guestDevices: stale.guestNodes.length,
      },
      "closed access whose device changed owner",
    );
  }
  return stale;
}

/** The role of each member of a tailnet, for role-restricted service posts. */
export async function loadMemberRoles(tenantId: string): Promise<Map<string, MemberRole>> {
  const rows = await db
    .select({ userId: memberships.userId, roleId: memberships.roleId, isOriginator: memberships.isOriginator })
    .from(memberships)
    .where(eq(memberships.tenantId, tenantId));
  return new Map(rows.map((r) => [r.userId, { roleId: r.roleId, isOriginator: r.isOriginator }]));
}

/** Connections that the roles of the members still allow. Reads the roles only when a post is for some roles. */
export async function allowedConnections<C extends { postId: string; userId?: string }>(
  tenantId: string,
  posts: Array<{ id: string; authorId?: string; allowedRoleIds?: string[] | null }>,
  connections: C[],
): Promise<C[]> {
  if (!posts.some((p) => (p.allowedRoleIds ?? []).length > 0)) return connections;
  return connectionsAllowedByRole(posts, connections, await loadMemberRoles(tenantId));
}

/** Compile the current access rules of a tailnet from the database. */
export async function loadTenantAccess(
  tenantId: string,
  mode: AccessMode,
  nodeOwners?: ReadonlyMap<string, string>,
  /** The tailnet's second approval: while on, no member's key admits a device. */
  secondApproval = true,
): Promise<CoordinatorAccess> {
  const posts = await db.select().from(servicePosts).where(eq(servicePosts.tenantId, tenantId));
  const postIds = posts.filter((p) => p.board === "public" && p.status === "approved").map((p) => p.id);
  const connected = postIds.length
    ? await db.select().from(serviceConnections).where(inArray(serviceConnections.postId, postIds))
    : [];
  const connections = await allowedConnections(tenantId, posts, connected);
  const shares = await db.select().from(deviceShares).where(eq(deviceShares.tenantId, tenantId));
  // Security: only a member's own choice puts their devices under the open policy
  const openOwners =
    mode === "open"
      ? (
          await db
            .select({ userId: memberships.userId })
            .from(memberships)
            .where(and(eq(memberships.tenantId, tenantId), eq(memberships.openAccess, true)))
        ).map((m) => m.userId)
      : [];
  // Security: only a member's own choice lets their key admit a device, and the second approval overrides it
  const unheldOwners =
    !secondApproval
      ? (
          await db
            .select({ userId: memberships.userId })
            .from(memberships)
            .where(and(eq(memberships.tenantId, tenantId), eq(memberships.approveOwnDevices, false)))
        ).map((m) => m.userId)
      : [];
  return compileAccess({ mode, posts, connections, shares, nodeOwners, openOwners, unheldOwners });
}

/** Compile the current device and service names of a tailnet from the database. */
export async function loadTenantDns(
  tenant: { id: string; slug: string },
  nodeOwners?: ReadonlyMap<string, string>,
): Promise<CoordinatorDns> {
  const posts = await db.select().from(servicePosts).where(eq(servicePosts.tenantId, tenant.id));
  const named = posts.filter((p) => p.name && p.status !== "removed");
  const publicIds = named.filter((p) => p.board === "public" && p.status === "approved").map((p) => p.id);
  const connected = publicIds.length
    ? await db.select().from(serviceConnections).where(inArray(serviceConnections.postId, publicIds))
    : [];
  const connections = await allowedConnections(tenant.id, named, connected);
  return compileDns({
    baseDomain: config.baseDomain,
    tailnetLabel: await primaryHostname(tenant.id, tenant.slug),
    upstream: config.tailnetDnsUpstream,
    posts: named,
    connections,
    nodeOwners,
  });
}

/**
 * Pushes a tailnet's access rules and names to the coordinator.
 * Returns false on failure; the caller's change is saved and the monitor retries.
 */
export async function syncTenantAccess(tenantId: string, opts: { secondApproval?: boolean } = {}): Promise<boolean> {
  const [tenant] = await db
    .select({
      id: tenants.id,
      coordinatorTenantId: tenants.coordinatorTenantId,
      accessMode: tenants.accessMode,
      slug: tenants.slug,
      requireDeviceApproval: tenants.requireDeviceApproval,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!tenant?.coordinatorTenantId) return true;
  try {
    const mode: AccessMode = tenant.accessMode === "member" ? "member" : "open";
    const client = getCoordinatorClient(tenant);
    // Ownership is checked against the control plane on every push: a device
    // that registered again under another member keeps its node id
    const nodeOwners = new Map<string, string>();
    for (const n of await client.listNodes()) {
      if (n.user?.id != null) nodeOwners.set(String(n.id), String(n.user.id));
    }
    await closeStaleAccess(tenantId, nodeOwners);
    const access = await loadTenantAccess(tenantId, mode, nodeOwners, opts.secondApproval ?? tenant.requireDeviceApproval);
    await client.setAccess(access);
    await client.setDns(await loadTenantDns(tenant, nodeOwners));
    return true;
  } catch (err) {
    logger.error({ tenantSlug: tenant.slug, err }, "failed to push access rules and names to the coordinator");
    return false;
  }
}

/**
 * Ends expired shares and pushes the affected tailnets' rules, so access closes on time.
 * Called by the monitor.
 */
export async function endExpiredShares(now = new Date()): Promise<number> {
  const ended = await db
    .update(deviceShares)
    .set({ status: "ended", endedAt: now })
    .where(and(inArray(deviceShares.status, ["requested", "offered", "active"]), lt(deviceShares.expiresAt, now)))
    .returning({ tenantId: deviceShares.tenantId });
  for (const tenantId of new Set(ended.map((e) => e.tenantId))) {
    await syncTenantAccess(tenantId);
  }
  return ended.length;
}
