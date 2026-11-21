/**
 * @module orchestrator/machine-refusals
 * Tell members when their machine lock refused a machine (ADR-0035). The
 * coordinator records refused attempts; the monitor asks for the new ones and
 * writes one notification for each to the owner of the lock.
 */

import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { instanceSettings, tenants } from "../db/schema.js";
import { logger } from "../logger.js";
import { notifyUser } from "../notifications/service.js";
import type { RefusedMachine } from "./coordinator-api.js";
import { getCoordinatorClient } from "./control-client.js";

/** Most notifications written in one round (a flood of attempts is one story). */
export const MAX_REFUSALS_PER_ROUND = 50;

async function watermark(): Promise<Date | null> {
  const [row] = await db
    .select({ at: instanceSettings.machineRefusedSeenAt })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 1));
  return row?.at ?? null;
}

async function setWatermark(at: Date): Promise<void> {
  await db
    .insert(instanceSettings)
    .values({ id: 1, machineRefusedSeenAt: at })
    .onConflictDoUpdate({ target: instanceSettings.id, set: { machineRefusedSeenAt: at } });
}

/**
 * Runs one round and returns the number of notifications written.
 * `list` is a parameter so that tests need no coordinator.
 */
export async function notifyRefusedMachines(
  list: (since: Date) => Promise<RefusedMachine[]> = (since) =>
    getCoordinatorClient().listRefusedMachines(since),
  now: Date = new Date(),
): Promise<number> {
  const since = await watermark();
  if (!since) {
    // First run: start from now, so that old attempts do not all arrive at once
    await setWatermark(now);
    return 0;
  }
  const refused = (await list(since)).slice(0, MAX_REFUSALS_PER_ROUND);
  if (refused.length === 0) return 0;

  const coordIds = [...new Set(refused.map((r) => r.tenant_id))];
  const rows = await db
    .select({ id: tenants.id, coordinatorTenantId: tenants.coordinatorTenantId })
    .from(tenants)
    .where(inArray(tenants.coordinatorTenantId, coordIds));
  const tenantOf = new Map(rows.map((r) => [r.coordinatorTenantId, r.id]));

  let written = 0;
  let latest = since;
  for (const r of refused) {
    const at = new Date(r.at);
    if (at > latest) latest = at;
    const tenantId = tenantOf.get(r.tenant_id);
    if (!tenantId) continue;
    notifyUser(tenantId, r.owner, "machine_refused", {
      title: `Your device lock refused "${r.hostname || "a machine"}"`,
      body: `A machine (${r.os || "unknown system"}, key ${r.fingerprint}) tried to join as you. If this was not you, revoke your auth keys and check your account.`,
      link: "/#devices",
    });
    written++;
  }
  await setWatermark(latest);
  if (written > 0) logger.info({ written }, "notified members about refused machines");
  return written;
}
