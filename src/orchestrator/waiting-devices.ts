/**
 * @module orchestrator/waiting-devices
 * Watches the devices that wait for admission (ADR-0039): tells the owner about a new one
 * and removes one that waited longer than the tailnet allows.
 */

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants, waitingDevices } from "../db/schema.js";
import { getCoordinatorClient } from "./control-client.js";
import type { HeadscaleNode } from "./headscale-api.js";
import { holdOf, isAdmitted, tenantMembers } from "../access/device-holds.js";
import { notify, notifyUser } from "../notifications/service.js";
import { logAudit } from "../audit/log.js";
import { logger } from "../logger.js";

export const DEFAULT_WAITING_HOURS = 168;
export const MAX_WAITING_HOURS = 8760;

export interface WaitingRow {
  nodeId: string;
  ownerId: string | null;
  firstSeenAt: Date;
}

export interface WaitingPlan {
  /** Devices whose wait starts now. */
  started: HeadscaleNode[];
  /** Rows of devices that no longer wait, or that wait for another owner. */
  ended: string[];
  /** Devices that waited too long. */
  expired: HeadscaleNode[];
}

const ownerOf = (n: HeadscaleNode) => n.user?.name ?? null;

/** When a wait that began at `firstSeenAt` ends. */
export function waitExpiry(firstSeenAt: Date, hours: number): Date {
  return new Date(firstSeenAt.getTime() + hours * 3_600_000);
}

/** Compares the devices of a tailnet with the waits on record. Pure. */
export function planWaiting(nodes: HeadscaleNode[], rows: WaitingRow[], hours: number, now: Date): WaitingPlan {
  const waiting = new Map(nodes.filter((n) => !isAdmitted(n)).map((n) => [String(n.id), n]));
  const plan: WaitingPlan = { started: [], ended: [], expired: [] };
  const known = new Set<string>();
  for (const row of rows) {
    const node = waiting.get(row.nodeId);
    if (!node || ownerOf(node) !== row.ownerId) {
      plan.ended.push(row.nodeId);
    } else {
      known.add(row.nodeId);
      if (waitExpiry(row.firstSeenAt, hours) <= now) plan.expired.push(node);
    }
  }
  for (const [id, node] of waiting) if (!known.has(id)) plan.started.push(node);
  return plan;
}

const label = (n: HeadscaleNode) => `${n.givenName || n.name} (${n.os || "unknown system"}, key ${n.fingerprint ?? "unknown"})`;

/** One round for every coordinator tailnet. A failure in one tailnet does not stop the others. */
export async function sweepWaitingDevices(now: Date = new Date()): Promise<void> {
  const rows = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      ownerUserId: tenants.ownerUserId,
      coordinatorTenantId: tenants.coordinatorTenantId,
      waitingDeviceHours: tenants.waitingDeviceHours,
    })
    .from(tenants)
    .where(and(eq(tenants.status, "running"), isNotNull(tenants.coordinatorTenantId)));
  for (const tenant of rows) {
    try {
      await sweepTenant(tenant, now);
    } catch (err) {
      logger.warn({ tenantId: tenant.id, err }, "failed to check waiting devices");
    }
  }
}

async function sweepTenant(
  tenant: { id: string; name: string; ownerUserId: string; coordinatorTenantId: string | null; waitingDeviceHours: number },
  now: Date,
): Promise<void> {
  const client = getCoordinatorClient(tenant);
  const nodes = await client.listNodes();
  const known = await db
    .select({ nodeId: waitingDevices.nodeId, ownerId: waitingDevices.ownerId, firstSeenAt: waitingDevices.firstSeenAt })
    .from(waitingDevices)
    .where(eq(waitingDevices.tenantId, tenant.id));
  if (known.length === 0 && nodes.every(isAdmitted)) return;
  const plan = planWaiting(nodes, known, tenant.waitingDeviceHours, now);

  for (const node of plan.expired) {
    await client.deleteNode(String(node.id));
    plan.ended.push(String(node.id));
    // The audit log needs an actor: the originator stands for the tailnet's own rule
    logAudit({
      tenantId: tenant.id,
      actorUserId: tenant.ownerUserId,
      action: "device_expired",
      targetType: "device",
      targetId: String(node.id),
      metadata: { by: "system", hours: tenant.waitingDeviceHours, fingerprint: node.fingerprint ?? null, hostname: node.givenName || node.name, ownerId: ownerOf(node) },
    });
  }
  if (plan.ended.length > 0) {
    await db.delete(waitingDevices).where(and(eq(waitingDevices.tenantId, tenant.id), inArray(waitingDevices.nodeId, plan.ended)));
  }
  if (plan.started.length === 0) return;

  await db
    .insert(waitingDevices)
    .values(plan.started.map((n) => ({ tenantId: tenant.id, nodeId: String(n.id), ownerId: ownerOf(n), firstSeenAt: now })))
    .onConflictDoNothing();
  const { handles } = await tenantMembers(tenant.id);
  for (const node of plan.started) {
    const owner = ownerOf(node);
    // A device that already waits for an approver was announced when its owner admitted it
    if (holdOf(node) !== "owner") continue;
    if (owner && handles.has(owner)) {
      notifyUser(tenant.id, owner, "device_waiting", {
        title: "A new device waits for you",
        body: `${label(node)} was added to ${tenant.name} with one of your keys. Admit it only if you added it yourself. If you do not know it, refuse it and revoke your keys.`,
        link: "/#overview",
      });
    } else {
      notify(tenant.id, "device_approval_requested", {
        title: "A device without an owner waits for approval",
        body: `${label(node)} was added to ${tenant.name}.`,
        link: "/#overview",
      });
    }
  }
}
