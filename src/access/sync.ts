/**
 * @module access/sync
 * Loads a tailnet's access state from the database, compiles it and sends it
 * to the coordinator, which stores and enforces it (ADR-0036). Call after
 * every change to posts, connections, shares or the access mode.
 */

import { and, eq, inArray, lt, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants, servicePosts, serviceConnections, deviceShares } from "../db/schema.js";
import { config } from "../config.js";
import { CoordinatorApiClient } from "../orchestrator/coordinator-api.js";
import { logger } from "../logger.js";
import {
  compileAccess,
  compileDns,
  findStaleAccess,
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
 * Close what a device's change of owner made stale (see `findStaleAccess`):
 * shares end, posts are withdrawn with a reason the author sees, connections
 * are removed, and lost guest devices leave the share. Persisted, so access
 * does not come back if the device later returns to its first owner.
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

/** Compile the current access rules of a tailnet from the database. */
export async function loadTenantAccess(
  tenantId: string,
  mode: AccessMode,
  nodeOwners?: ReadonlyMap<string, string>,
): Promise<CoordinatorAccess> {
  if (mode !== "member") return { mode: "open", rules: [] };
  const posts = await db.select().from(servicePosts).where(eq(servicePosts.tenantId, tenantId));
  const postIds = posts.filter((p) => p.board === "public" && p.status === "approved").map((p) => p.id);
  const connections = postIds.length
    ? await db.select().from(serviceConnections).where(inArray(serviceConnections.postId, postIds))
    : [];
  const shares = await db.select().from(deviceShares).where(eq(deviceShares.tenantId, tenantId));
  return compileAccess({ mode, posts, connections, shares, nodeOwners });
}

/** Compile the current device and service names of a tailnet from the database. */
export async function loadTenantDns(
  tenant: { id: string; slug: string },
  nodeOwners?: ReadonlyMap<string, string>,
): Promise<CoordinatorDns> {
  const posts = await db.select().from(servicePosts).where(eq(servicePosts.tenantId, tenant.id));
  const named = posts.filter((p) => p.name && p.status !== "removed");
  const publicIds = named.filter((p) => p.board === "public" && p.status === "approved").map((p) => p.id);
  const connections = publicIds.length
    ? await db.select().from(serviceConnections).where(inArray(serviceConnections.postId, publicIds))
    : [];
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
 * Push a tailnet's access rules and names to the coordinator. Returns false when the
 * push failed (the caller's change is saved; the monitor retries). No-op
 * outside coordinator mode, where per-device rules cannot be enforced.
 */
export async function syncTenantAccess(tenantId: string): Promise<boolean> {
  if (!config.coordinatorUrl) return true;
  const [tenant] = await db
    .select({ id: tenants.id, coordinatorTenantId: tenants.coordinatorTenantId, accessMode: tenants.accessMode, slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!tenant?.coordinatorTenantId) return true;
  try {
    const mode: AccessMode = tenant.accessMode === "member" ? "member" : "open";
    const client = new CoordinatorApiClient(config.coordinatorUrl, tenant.coordinatorTenantId, config.coordinatorApiKey);
    // Ownership is checked against the control plane on every push: a device
    // that registered again under another member keeps its node id
    const nodeOwners = new Map<string, string>();
    for (const n of await client.listNodes()) {
      if (n.user?.id != null) nodeOwners.set(String(n.id), String(n.user.id));
    }
    await closeStaleAccess(tenantId, nodeOwners);
    const access = await loadTenantAccess(tenantId, mode, nodeOwners);
    await client.setAccess(access);
    await client.setDns(await loadTenantDns(tenant, nodeOwners));
    return true;
  } catch (err) {
    logger.error({ tenantSlug: tenant.slug, err }, "failed to push access rules and names to the coordinator");
    return false;
  }
}

/**
 * End shares whose expiry passed and push the affected tailnets' rules, so
 * access closes on time. The compiler already treats an expired share as
 * inactive, so any push after the expiry closes it; this marks it ended and
 * forces that push. Called by the monitor.
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
