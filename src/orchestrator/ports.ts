/**
 * @module orchestrator/ports
 * Port allocator for Headscale containers.
 * Scans the configured port range and returns the first port not
 * already claimed by a non-deleted tenant in the database.
 */

import { ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants } from "../db/schema.js";
import { config } from "../config.js";

/**
 * Allocate the next available port from the configured range.
 * Queries all non-deleted tenants to build the used-port set, then
 * returns the lowest unused port. Throws if the range is exhausted.
 */
export async function allocatePort(): Promise<number> {
  const { portRangeStart, portRangeEnd } = config.headscale;

  const usedPorts = await db
    .select({ port: tenants.port })
    .from(tenants)
    .where(ne(tenants.status, "deleted"));

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
