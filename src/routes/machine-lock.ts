/**
 * @module routes/machine-lock
 * Machine lock (ADR-0035 §2): a member pins their devices to current machines; the coordinator enforces it.
 * Session only; with trusted devices every change needs a fresh device proof.
 */

import { Router, type Response } from "express";
import { z } from "zod";
import type { tenants } from "../db/schema.js";
import { requireSession } from "./helpers.js";
import { tenantGuard, tenantCtx } from "./guard.js";
import { logAudit } from "../audit/log.js";
import { logger } from "../logger.js";
import type { OwnerLockView } from "../orchestrator/coordinator-api.js";
import { getCoordinatorClient } from "../orchestrator/control-client.js";
import { listUserDevices } from "../access/devices.js";
import { syncTenantAccess } from "../access/sync.js";
import { requireFreshDeviceProof } from "./device-trust.js";

export const machineLockRouter = Router({ caseSensitive: true });

/** How long "allow one new device" stays open. */
export const ALLOW_ONE_SECONDS = 10 * 60;

const lockSchema = z.object({
  deviceIds: z.array(z.string().regex(/^\d{1,18}$/)).max(64),
  /** Most devices the lock may hold; absent = no limit of the member's own. */
  maxDevices: z.number().int().min(1).max(64).optional(),
});

type Tenant = typeof tenants.$inferSelect;

/** The caller and the coordinator client, or a response and null while the tailnet is not provisioned. Runs after {@link tenantGuard}. */
function context(res: Response) {
  const { userId, tenant } = tenantCtx(res);
  if (!tenant.coordinatorTenantId) {
    res.status(409).json({ error: "This tailnet is not ready yet", code: "not_ready" });
    return null;
  }
  return { userId, tenant, coord: getCoordinatorClient(tenant) };
}

async function view(tenant: Tenant, userId: string, lock: OwnerLockView) {
  const devices = await listUserDevices(tenant, userId);
  const allowed = new Set(lock.node_ids.map(String));
  return {
    locked: lock.locked,
    devices: devices.map((d) => ({ id: d.id, name: d.name, online: d.online, allowed: lock.locked ? allowed.has(d.id) : true })),
    allowOneUntil: lock.allow_one_until ?? null,
    maxDevices: lock.max_machines ?? null,
    refused: [...lock.refused].reverse(),
  };
}

machineLockRouter.get("/api/tenants/:tenantId/machine-lock", requireSession, tenantGuard(), async (_req, res) => {
  const ctx = context(res);
  if (!ctx) return;
  res.json(await view(ctx.tenant, ctx.userId, await ctx.coord.getOwnerLock(ctx.userId)));
});

/** Lock to the chosen devices. The member's other devices leave the tailnet. */
machineLockRouter.put("/api/tenants/:tenantId/machine-lock", requireSession, tenantGuard(), async (req, res) => {
  const ctx = context(res);
  if (!ctx || !(await requireFreshDeviceProof(req, res))) return;
  const parsed = lockSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Choose the devices to keep" });
    return;
  }
  const mine = await listUserDevices(ctx.tenant, ctx.userId);
  const keep = [...new Set(parsed.data.deviceIds)];
  if (keep.some((id) => !mine.some((d) => d.id === id))) {
    res.status(400).json({ error: "You can only lock to your own devices in this tailnet" });
    return;
  }
  if (keep.length === 0 && mine.length > 0) {
    res.status(400).json({ error: "Keep at least one device, or remove your devices first" });
    return;
  }
  const max = parsed.data.maxDevices;
  if (max !== undefined && max < keep.length) {
    res.status(400).json({ error: "The limit cannot be below the number of devices that stay" });
    return;
  }
  const lock = await ctx.coord.setOwnerLock(ctx.userId, keep.map(Number), max);
  // Removed devices can no longer be the target of rules or names
  await syncTenantAccess(ctx.tenant.id).catch((err) => logger.warn({ err }, "access sync after machine lock failed"));
  logAudit({
    tenantId: ctx.tenant.id,
    actorUserId: ctx.userId,
    action: "device_locked",
    targetType: "user",
    targetId: ctx.userId,
    metadata: { self: true, devices: keep.length, removed: lock.removed_nodes ?? 0 },
  });
  res.json(await view(ctx.tenant, ctx.userId, lock));
});

/** For a short time, the next new machine of this member is added to the lock. */
machineLockRouter.post("/api/tenants/:tenantId/machine-lock/allow-one", requireSession, tenantGuard(), async (req, res) => {
  const ctx = context(res);
  if (!ctx || !(await requireFreshDeviceProof(req, res))) return;
  const lock = await ctx.coord.allowOneMachine(ctx.userId, ALLOW_ONE_SECONDS);
  if (!lock) {
    res.status(409).json({ error: "Your devices are not locked in this tailnet" });
    return;
  }
  if (lock === "full") {
    res.status(409).json({ error: "The lock is at its device limit. Raise the limit or remove a device first", code: "lock_full" });
    return;
  }
  logAudit({
    tenantId: ctx.tenant.id,
    actorUserId: ctx.userId,
    action: "device_unlocked",
    targetType: "user",
    targetId: ctx.userId,
    metadata: { self: true, allowOne: true, seconds: ALLOW_ONE_SECONDS },
  });
  res.json(await view(ctx.tenant, ctx.userId, lock));
});

machineLockRouter.delete("/api/tenants/:tenantId/machine-lock", requireSession, tenantGuard(), async (req, res) => {
  const ctx = context(res);
  if (!ctx || !(await requireFreshDeviceProof(req, res))) return;
  await ctx.coord.deleteOwnerLock(ctx.userId);
  logAudit({
    tenantId: ctx.tenant.id,
    actorUserId: ctx.userId,
    action: "device_unlocked",
    targetType: "user",
    targetId: ctx.userId,
    metadata: { self: true },
  });
  res.json(await view(ctx.tenant, ctx.userId, { locked: false, node_ids: [], allow_one_until: null, refused: [] }));
});
