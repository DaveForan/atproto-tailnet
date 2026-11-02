/**
 * @module orchestrator/monitor
 * Background health-check and hibernation loop for Headscale tenant instances.
 * Queries the DB for tenants with status "running" and a non-null containerId,
 * probes each via the Headscale REST API, and attempts a Docker restart on
 * failure (marking the tenant "error" if the restart also fails).
 * Also stops idle tenants whose lastActivityAt exceeds hibernateAfterDays.
 */

import { eq, and, isNotNull, gt, lt, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants, memberships, usageSnapshots } from "../db/schema.js";
import { HeadscaleApiClient } from "./headscale-api.js";
import { startInstance, stopInstance } from "./headscale.js";
import { logAudit } from "../routes/audit.js";
import { logger } from "../logger.js";

/**
 * Run a single health-check sweep across all running tenants.
 * Exported for the per-tenant endpoint to reuse (and for testability).
 */
export async function checkAllTenants(): Promise<void> {
  const running = await db
    .select({
      id: tenants.id,
      slug: tenants.slug,
      port: tenants.port,
      apiKey: tenants.apiKey,
      containerId: tenants.containerId,
    })
    .from(tenants)
    .where(and(eq(tenants.status, "running"), isNotNull(tenants.containerId)));

  for (const tenant of running) {
    const client = new HeadscaleApiClient(tenant.port, tenant.apiKey);
    const healthy = await client.healthcheck();

    if (healthy) {
      logger.debug({ tenantSlug: tenant.slug }, "health check passed");
      continue;
    }

    logger.warn({ tenantSlug: tenant.slug }, "health check failed, attempting restart");

    try {
      await startInstance(tenant.containerId!);
      logger.info({ tenantSlug: tenant.slug }, "restart succeeded");
    } catch (err) {
      logger.error({ tenantSlug: tenant.slug, err }, "restart failed, marking tenant error");
      await db
        .update(tenants)
        .set({ status: "error", updatedAt: new Date() })
        .where(eq(tenants.id, tenant.id));
    }
  }
}

/**
 * Hibernate tenants whose lastActivityAt exceeds their hibernateAfterDays threshold.
 * Only considers running tenants with hibernateAfterDays > 0.
 */
export async function hibernateIdleTenants(): Promise<void> {
  const candidates = await db
    .select({
      id: tenants.id,
      slug: tenants.slug,
      containerId: tenants.containerId,
      ownerUserId: tenants.ownerUserId,
      hibernateAfterDays: tenants.hibernateAfterDays,
      lastActivityAt: tenants.lastActivityAt,
    })
    .from(tenants)
    .where(
      and(
        eq(tenants.status, "running"),
        isNotNull(tenants.containerId),
        gt(tenants.hibernateAfterDays, 0),
      ),
    );

  const now = Date.now();

  for (const tenant of candidates) {
    const idleMs = now - tenant.lastActivityAt.getTime();
    const thresholdMs = tenant.hibernateAfterDays * 24 * 60 * 60 * 1000;

    if (idleMs < thresholdMs) continue;

    logger.info(
      { tenantSlug: tenant.slug, idleDays: Math.floor(idleMs / 86_400_000) },
      "hibernating idle tenant",
    );

    try {
      await stopInstance(tenant.containerId!);
      await db
        .update(tenants)
        .set({ status: "stopped", updatedAt: new Date() })
        .where(eq(tenants.id, tenant.id));

      logAudit({
        tenantId: tenant.id,
        actorUserId: tenant.ownerUserId,
        action: "tenant_hibernated",
        targetType: "tenant",
        targetId: tenant.id,
        metadata: { idleDays: Math.floor(idleMs / 86_400_000), threshold: tenant.hibernateAfterDays },
      });
    } catch (err) {
      logger.error({ tenantSlug: tenant.slug, err }, "failed to hibernate tenant");
    }
  }
}

/**
 * Check the health of a single tenant's Headscale instance.
 * Returns a status object suitable for the per-tenant health endpoint.
 */
export async function checkTenantHealth(
  port: number,
  apiKey: string,
): Promise<{ healthy: boolean }> {
  const client = new HeadscaleApiClient(port, apiKey);
  const healthy = await client.healthcheck();
  return { healthy };
}

/**
 * Record a usage snapshot for each running tenant.
 * Counts devices (from Headscale API) and members (from DB).
 */
export async function recordUsageSnapshots(): Promise<void> {
  const running = await db
    .select({
      id: tenants.id,
      port: tenants.port,
      apiKey: tenants.apiKey,
    })
    .from(tenants)
    .where(and(eq(tenants.status, "running"), isNotNull(tenants.containerId)));

  for (const tenant of running) {
    try {
      const client = new HeadscaleApiClient(tenant.port, tenant.apiKey);
      const [nodes, routes, memberRows] = await Promise.all([
        client.listNodes(),
        client.listRoutes().catch(() => []),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(memberships)
          .where(eq(memberships.tenantId, tenant.id)),
      ]);

      await db.insert(usageSnapshots).values({
        tenantId: tenant.id,
        deviceCount: nodes.length,
        onlineDevices: nodes.filter((n) => n.online).length,
        routeCount: routes.length,
        memberCount: memberRows[0]?.count ?? 0,
      });
    } catch (err) {
      logger.error({ tenantId: tenant.id, err }, "failed to record usage snapshot");
    }
  }
}

/** Start the background health-check interval. Call once after server listen. */
export function startHealthMonitor(intervalMs = 60_000): void {
  logger.info({ intervalMs }, "starting health monitor");
  let tick = 0;
  setInterval(async () => {
    tick++;
    try {
      await checkAllTenants();
      await hibernateIdleTenants();
      if (tick % 5 === 0) {
        await recordUsageSnapshots();
      }
    } catch (err) {
      logger.error({ err }, "health monitor sweep failed");
    }
  }, intervalMs);
}
