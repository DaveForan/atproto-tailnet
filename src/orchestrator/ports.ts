/**
 * @module orchestrator/ports
 * Port allocator for Headscale containers. `tenants.port` is UNIQUE across all rows, deleted ones included.
 * Rows without a container get a unique negative placeholder. Nothing dials a negative port.
 */

import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants } from "../db/schema.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

/**
 * Returns the first free real port in the configured range.
 * Errors: throws when the range is exhausted.
 */
export async function allocatePort(): Promise<number> {
  const { portRangeStart, portRangeEnd } = config.headscale;

  await reclaimDeletedTenantPorts();

  const usedPorts = await db.select({ port: tenants.port }).from(tenants);
  const usedSet = new Set(usedPorts.map((r) => r.port));

  for (let port = portRangeStart; port <= portRangeEnd; port++) {
    if (!usedSet.has(port)) {
      return port;
    }
  }

  throw new Error(
    `No available ports in range ${portRangeStart}-${portRangeEnd}`,
  );
}

/**
 * Returns a unique negative placeholder for tenants that have no Headscale
 * container. It is racy, so callers must retry on PG 23505.
 */
export async function allocateSyntheticPort(): Promise<number> {
  const [row] = await db
    .select({ min: sql<number>`LEAST(COALESCE(MIN(${tenants.port}), 0), 0)::int` })
    .from(tenants);
  return (row?.min ?? 0) - 1;
}

export async function allocateTenantPort(needsHeadscalePort: boolean): Promise<number> {
  return needsHeadscalePort ? allocatePort() : allocateSyntheticPort();
}

/** Moves a deleted tenant's row to a placeholder so its real port is free. Retries on unique-violation races. */
export async function releaseTenantPort(tenantId: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const placeholder = await allocateSyntheticPort();
      await db
        .update(tenants)
        .set({ port: placeholder })
        .where(and(eq(tenants.id, tenantId), gt(tenants.port, 0)));
      return;
    } catch (err: unknown) {
      if ((err as { code?: string }).code !== "23505" || attempt === 2) throw err;
    }
  }
}

async function reclaimDeletedTenantPorts(): Promise<void> {
  const stale = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(eq(tenants.status, "deleted"), gt(tenants.port, 0)));
  for (const { id } of stale) {
    await releaseTenantPort(id).catch((err) =>
      logger.warn({ tenantId: id, err }, "failed to release deleted tenant port"),
    );
  }
}
