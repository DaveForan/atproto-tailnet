/**
 * @module orchestrator/ports
 * Port allocator for Headscale containers.
 *
 * `tenants.port` is `NOT NULL UNIQUE` across **all** rows (deleted tenants
 * included), so:
 *
 * - {@link allocatePort} excludes every row's port, not just live tenants'.
 * - Deleted tenants give their real port back via {@link releaseTenantPort},
 *   which moves the row onto a synthetic (negative) placeholder value.
 * - Tenants without a Headscale container (coordinator mode, sub-collectives)
 *   get a synthetic negative placeholder from {@link allocateSyntheticPort}
 *   instead of consuming a real port (or a shared `0` that collides on the
 *   second insert). Negative values are never dialed: Headscale clients are
 *   only built for tenants with a container/API key, and coordinator mode
 *   ignores the port entirely.
 */

import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants } from "../db/schema.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

/**
 * Allocate the next available real port from the configured range.
 * Excludes ports held by any tenant row (the unique index covers deleted
 * rows too). Reclaims real ports still held by deleted tenants first.
 * Throws if the range is exhausted.
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
 * container. Racy by design (MIN-1); callers must retry on PG 23505.
 */
export async function allocateSyntheticPort(): Promise<number> {
  const [row] = await db
    .select({ min: sql<number>`LEAST(COALESCE(MIN(${tenants.port}), 0), 0)::int` })
    .from(tenants);
  return (row?.min ?? 0) - 1;
}

/**
 * Port for a newly inserted tenant: a real port when it will run a Headscale
 * container, a synthetic placeholder otherwise.
 */
export async function allocateTenantPort(needsHeadscalePort: boolean): Promise<number> {
  return needsHeadscalePort ? allocatePort() : allocateSyntheticPort();
}

/**
 * Frees a (deleted) tenant's real port by moving the row to a synthetic
 * placeholder. Best effort: retries a few times on unique-violation races.
 */
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

/** Moves deleted tenants still holding a real port onto placeholders. */
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
