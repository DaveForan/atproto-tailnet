/**
 * @module access/sync
 * Loads a tailnet's access state from the database, compiles it and sends it
 * to the coordinator, which stores and enforces it (ADR-0036). Call after
 * every change to posts, connections, shares or the access mode.
 */

import { and, eq, inArray, lt } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants, servicePosts, serviceConnections, deviceShares } from "../db/schema.js";
import { config } from "../config.js";
import { CoordinatorApiClient } from "../orchestrator/coordinator-api.js";
import { logger } from "../logger.js";
import { compileAccess, compileDns, type AccessMode, type CoordinatorAccess, type CoordinatorDns } from "./compiler.js";
import { primaryHostname } from "../orchestrator/hostnames.js";

/** Compile the current access rules of a tailnet from the database. */
export async function loadTenantAccess(tenantId: string, mode: AccessMode): Promise<CoordinatorAccess> {
  if (mode !== "member") return { mode: "open", rules: [] };
  const posts = await db.select().from(servicePosts).where(eq(servicePosts.tenantId, tenantId));
  const postIds = posts.filter((p) => p.board === "public" && p.status === "approved").map((p) => p.id);
  const connections = postIds.length
    ? await db.select().from(serviceConnections).where(inArray(serviceConnections.postId, postIds))
    : [];
  const shares = await db.select().from(deviceShares).where(eq(deviceShares.tenantId, tenantId));
  return compileAccess({ mode, posts, connections, shares });
}

/** Compile the current device and service names of a tailnet from the database. */
export async function loadTenantDns(tenant: { id: string; slug: string }): Promise<CoordinatorDns> {
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
    const access = await loadTenantAccess(tenantId, mode);
    const client = new CoordinatorApiClient(config.coordinatorUrl, tenant.coordinatorTenantId, config.coordinatorApiKey);
    await client.setAccess(access);
    await client.setDns(await loadTenantDns(tenant));
    return true;
  } catch (err) {
    logger.error({ tenantSlug: tenant.slug, err }, "failed to push access rules and names to the coordinator");
    return false;
  }
}

/**
 * End shares whose expiry passed and push the affected tailnets' rules, so
 * access closes on time (the compiler already ignores expired shares; this
 * makes the coordinator's stored rules match). Called by the monitor.
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
