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
import { getControlClient, useCoordinator } from "./control-client.js";
import { startInstance, stopInstance } from "./headscale.js";
import { syncTenantRoutes } from "./caddy.js";
import { sweepExpiredJtis } from "../credentials/service-auth.js";
import { logAudit } from "../routes/audit.js";
import { logger } from "../logger.js";

/** Track consecutive health-check failures for coordinator-mode tenants. */
const coordinatorFailCounts = new Map<string, number>();

/**
 * Run a single health-check sweep across all running tenants.
 * Exported for the per-tenant endpoint to reuse (and for testability).
 */
export async function checkAllTenants(): Promise<void> {
  const whereClause = useCoordinator
    ? eq(tenants.status, "running")
    : and(eq(tenants.status, "running"), isNotNull(tenants.containerId));
  const running = await db
    .select({
      id: tenants.id,
      slug: tenants.slug,
      port: tenants.port,
      apiKey: tenants.apiKey,
      containerId: tenants.containerId,
      coordinatorTenantId: tenants.coordinatorTenantId,
    })
    .from(tenants)
    .where(whereClause);

  for (const tenant of running) {
    const client = getControlClient(tenant);
    const healthy = await client.healthcheck();

    if (healthy) {
      logger.debug({ tenantSlug: tenant.slug }, "health check passed");
      coordinatorFailCounts.delete(tenant.id);
      continue;
    }

    if (useCoordinator) {
      const count = (coordinatorFailCounts.get(tenant.id) ?? 0) + 1;
      coordinatorFailCounts.set(tenant.id, count);
      if (count >= 3) {
        logger.error(
          { tenantSlug: tenant.slug, consecutiveFailures: count },
          "coordinator health check failed repeatedly, marking error",
        );
        await db
          .update(tenants)
          .set({ status: "error", updatedAt: new Date() })
          .where(eq(tenants.id, tenant.id));
      } else {
        logger.warn(
          { tenantSlug: tenant.slug, consecutiveFailures: count },
          "coordinator health check failed",
        );
      }
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
  const filters = [
    eq(tenants.status, "running"),
    gt(tenants.hibernateAfterDays, 0),
  ];
  if (!useCoordinator) {
    filters.push(isNotNull(tenants.containerId));
  }

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
    .where(and(...filters));

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
      if (tenant.containerId) {
        await stopInstance(tenant.containerId);
      }
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
  tenant: { port: number; apiKey: string; coordinatorTenantId?: string | null },
): Promise<{ healthy: boolean }> {
  const client = getControlClient(tenant);
  const healthy = await client.healthcheck();
  return { healthy };
}

/**
 * Record a usage snapshot for each running tenant.
 * Counts devices (from Headscale API) and members (from DB).
 */
export async function recordUsageSnapshots(): Promise<void> {
  const usageWhere = useCoordinator
    ? eq(tenants.status, "running")
    : and(eq(tenants.status, "running"), isNotNull(tenants.containerId));
  const running = await db
    .select({
      id: tenants.id,
      port: tenants.port,
      apiKey: tenants.apiKey,
      coordinatorTenantId: tenants.coordinatorTenantId,
    })
    .from(tenants)
    .where(usageWhere);

  for (const tenant of running) {
    try {
      const client = getControlClient(tenant);
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
      // Caddy drops admin-API routes when it restarts from its Caddyfile.
      await syncTenantRoutes().catch((err) =>
        logger.warn({ err }, "failed to sync Caddy routes"),
      );
      if (tick % 5 === 0) {
        await recordUsageSnapshots();
        await sweepExpiredJtis().catch((err) =>
          logger.warn({ err }, "failed to sweep expired JTIs"),
        );
      }
    } catch (err) {
      logger.error({ err }, "health monitor sweep failed");
    }
  }, intervalMs);
}
