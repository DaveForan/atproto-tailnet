/**
 * @module orchestrator/monitor
 * Background health-check loop for running Headscale tenant instances.
 * Queries the DB for tenants with status "running" and a non-null containerId,
 * probes each via the Headscale REST API, and attempts a Docker restart on
 * failure (marking the tenant "error" if the restart also fails).
 */

import { eq, and, isNotNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants } from "../db/schema.js";
import { HeadscaleApiClient } from "./headscale-api.js";
import { startInstance } from "./headscale.js";
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

/** Start the background health-check interval. Call once after server listen. */
export function startHealthMonitor(intervalMs = 60_000): void {
  logger.info({ intervalMs }, "starting health monitor");
  setInterval(async () => {
    try {
      await checkAllTenants();
    } catch (err) {
      logger.error({ err }, "health monitor sweep failed");
    }
  }, intervalMs);
}
