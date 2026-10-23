import { ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants } from "../db/schema.js";
import { config } from "../config.js";

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
