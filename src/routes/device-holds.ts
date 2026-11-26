/**
 * @module routes/device-holds
 * Devices that wait for admission: list, admit and refuse.
 * The owner admits their own machine. With the tailnet's second step, an approver admits it too.
 */

import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { memberships, waitingDevices } from "../db/schema.js";
import { waitExpiry } from "../orchestrator/waiting-devices.js";
import { getCoordinatorClient } from "../orchestrator/control-client.js";
import type { ControlNode } from "../orchestrator/control-types.js";
import { requireAuth, requireSession, param, hasPermission, authUserId, isLockedDown, sendNotApplied } from "./helpers.js";
import { tenantGuard, tenantCtx } from "./guard.js";
import { stepUpForSession } from "../auth/step-up.js";
import { logAudit } from "../audit/log.js";
import { logger } from "../logger.js";
import { notify } from "../notifications/service.js";
import { admitStep, isAdmitted, tenantMembers, hasOtherApprover, holdAfterOwnerFor, type TenantMembers } from "../access/device-holds.js";
import { isAtCapacity } from "../access/admission.js";
import { sendDeviceRefusal } from "./limits.js";
import { syncTenantAccess } from "../access/sync.js";
import { revokeMemberAccess } from "../access/keys.js";

export const deviceHoldsRouter = Router({ caseSensitive: true });

const NO_AGENT = "Agent tokens cannot admit devices";

function waitingView(n: ControlNode, { handles }: TenantMembers, canAdmit: boolean, expiresAt: Date | null) {
  const ownerId = n.user?.name ?? null;
  return {
    id: n.id,
    name: n.givenName || n.name,
    os: n.os ?? "",
    fingerprint: n.fingerprint ?? "",
    hold: n.hold,
    canAdmit,
    /** When the device is removed if nobody admits it. Null until the monitor has seen it. */
    expiresAt: expiresAt?.toISOString() ?? null,
    owner: ownerId && handles.has(ownerId) ? { userId: ownerId, handle: handles.get(ownerId)! } : null,
  };
}

/** The caller's next step for one device: the list and the admit route use the same rule. */
function stepFor(n: ControlNode, members: TenantMembers, userId: string, canApprove: boolean, secondApproval: boolean) {
  const ownerId = n.user?.name ?? null;
  return admitStep({
    hold: n.hold,
    isOwner: ownerId === userId,
    ownerIsMember: !!ownerId && members.handles.has(ownerId),
    canApprove,
    secondApproval,
    otherApprover: hasOtherApprover(members, ownerId),
  });
}

/** `mine`: the caller's waiting devices. `queue`: what the caller may admit for the tailnet. */
deviceHoldsRouter.get(
  "/api/tenants/:tenantId/devices/waiting",
  requireAuth,
  tenantGuard(),
  async (req, res) => {
    const result = tenantCtx(res);
    try {
      const userId = authUserId(req);
      const nodes = (await getCoordinatorClient(result.tenant).listNodes()).filter((n) => !isAdmitted(n));
      const members = await tenantMembers(result.tenant.id);
      const canApprove = hasPermission(result.membership, result.role, "approve_devices", req);
      const seen = await db
        .select({ nodeId: waitingDevices.nodeId, firstSeenAt: waitingDevices.firstSeenAt })
        .from(waitingDevices)
        .where(eq(waitingDevices.tenantId, result.tenant.id));
      const since = new Map(seen.map((r) => [r.nodeId, r.firstSeenAt]));
      const view = (n: ControlNode) => {
        const first = since.get(String(n.id));
        return waitingView(
          n,
          members,
          "to" in stepFor(n, members, userId, canApprove, result.tenant.requireDeviceApproval),
          first ? waitExpiry(first, result.tenant.waitingDeviceHours) : null,
        );
      };
      const ownerless = (n: ControlNode) => !n.user?.name || !members.handles.has(n.user.name);
      res.json({
        mine: nodes.filter((n) => n.user?.name === userId).map(view),
        queue: canApprove ? nodes.filter((n) => n.user?.name !== userId && (n.hold === "approver" || ownerless(n))).map(view) : [],
      });
    } catch (err) {
      logger.error({ err }, "failed to list waiting devices");
      res.status(502).json({ error: "Failed to reach the coordinator" });
    }
  },
);

deviceHoldsRouter.post(
  "/api/tenants/:tenantId/devices/:nodeId/admit",
  requireSession,
  stepUpForSession,
  tenantGuard({ noAgentToken: NO_AGENT, notLockedDown: true }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const nodeId = param(req, "nodeId");
    const result = tenantCtx(res);
    const userId = authUserId(req);
    const client = getCoordinatorClient(result.tenant);
    let nodes: ControlNode[];
    try {
      nodes = await client.listNodes();
    } catch (err) {
      logger.error({ err }, "failed to read devices for admission");
      res.status(502).json({ error: "Failed to reach the coordinator" });
      return;
    }
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) {
      res.status(404).json({ error: "Device not found" });
      return;
    }
    const members = await tenantMembers(tenantId);
    const ownerId = node.user?.name ?? null;
    const { hold } = node;
    const step = stepFor(node, members, userId, hasPermission(result.membership, result.role, "approve_devices", req), result.tenant.requireDeviceApproval);
    if ("refusal" in step) {
      if (step.refusal === "not_waiting") {
        res.status(409).json({ error: "This device is already admitted" });
      } else if (step.refusal === "not_owner") {
        res.status(403).json({ error: "Only the owner of this device can admit it", code: "not_owner" });
      } else {
        res.status(403).json({ error: "Insufficient permissions" });
      }
      return;
    }
    // The limit counts admitted devices: a key can register more machines than it may admit.
    const admitted = nodes.filter(isAdmitted).length;
    if (step.to === "none" && isAtCapacity(admitted, result.tenant.maxDevices)) {
      sendDeviceRefusal(res, result.tenant, "device_limit");
      return;
    }
    try {
      if (!(await client.setNodeHold(nodeId, hold, step.to))) {
        res.status(409).json({ error: "This device changed. Load the page again" });
        return;
      }
    } catch (err) {
      logger.error({ err }, "failed to admit device");
      res.status(502).json({ error: "Failed to admit the device" });
      return;
    }
    logAudit({
      tenantId,
      actorUserId: userId,
      action: step.to === "none" ? "device_admitted" : "device_admitted_by_owner",
      targetType: "device",
      targetId: nodeId,
      metadata: { fingerprint: node.fingerprint ?? null, hostname: node.givenName || node.name, ownerId, from: hold },
    });
    if (step.to === "approver") {
      notify(tenantId, "device_approval_requested", {
        title: "A device waits for approval",
        body: `@${members.handles.get(userId) ?? "A member"} admitted the device ${node.givenName || node.name} (${node.fingerprint ?? "no fingerprint"}) to ${result.tenant.name}.`,
        link: "/#overview",
      });
    }
    res.json({ status: step.to === "none" ? "admitted" : "waiting_for_approver" });
  },
);

/** Removes a waiting device. The owner refuses their own; an approver refuses any waiting device. */
deviceHoldsRouter.post(
  "/api/tenants/:tenantId/devices/:nodeId/refuse",
  requireSession,
  tenantGuard({ noAgentToken: NO_AGENT }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const nodeId = param(req, "nodeId");
    const result = tenantCtx(res);
    const userId = authUserId(req);
    const client = getCoordinatorClient(result.tenant);
    try {
      const node = (await client.listNodes()).find((n) => n.id === nodeId);
      if (!node) {
        res.status(404).json({ error: "Device not found" });
        return;
      }
      if (isAdmitted(node)) {
        res.status(409).json({ error: "This device is already admitted. Remove it on the Devices page" });
        return;
      }
      const ownerId = node.user?.name ?? null;
      if (ownerId !== userId && !hasPermission(result.membership, result.role, "approve_devices", req)) {
        res.status(403).json({ error: "Insufficient permissions" });
        return;
      }
      await client.deleteNode(nodeId);
      logAudit({
        tenantId,
        actorUserId: userId,
        action: "device_refused",
        targetType: "device",
        targetId: nodeId,
        metadata: { fingerprint: node.fingerprint ?? null, hostname: node.givenName || node.name, ownerId },
      });
      res.json({ status: "refused" });
    } catch (err) {
      logger.error({ err }, "failed to refuse device");
      res.status(502).json({ error: "Failed to refuse the device" });
    }
  },
);

/** The caller's own approval of their new devices. `locked`: the tailnet's second approval forces it on. */
deviceHoldsRouter.get("/api/tenants/:tenantId/device-approval/mine", requireAuth, tenantGuard(), async (req, res) => {
  const { tenant, membership, role, userId } = tenantCtx(res);
  const locked = tenant.requireDeviceApproval;
  // `needsApprover`: after the caller admits a new device, another member must admit it too
  const needsApprover = (await holdAfterOwnerFor(tenant, hasPermission(membership, role, "approve_devices", req), userId)) === "approver";
  res.json({ on: locked || membership.approveOwnDevices, locked, needsApprover });
});

/**
 * The caller turns the approval of their own new devices on or off.
 * Security: while it is off, a key of this member admits a device at once. Nobody sets it for another member,
 * and the tailnet's second approval forces it on for every member.
 */
deviceHoldsRouter.put(
  "/api/tenants/:tenantId/device-approval/mine",
  requireSession,
  stepUpForSession,
  tenantGuard({ noAgentToken: "Only the member can change the approval of their own devices" }),
  async (req, res) => {
    const result = tenantCtx(res);
    const parsed = z.object({ on: z.boolean() }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "on must be true or false" });
      return;
    }
    if (!parsed.data.on) {
      if (result.tenant.requireDeviceApproval) {
        res.status(409).json({ error: "This tailnet requires every member to admit their own devices", code: "approval_locked" });
        return;
      }
      // Turning it on stays possible in lockdown: it only removes access
      if (isLockedDown(result.tenant)) {
        res.status(403).json({ error: "Tenant is in lockdown mode" });
        return;
      }
    }
    const set = (on: boolean) => db.update(memberships).set({ approveOwnDevices: on }).where(eq(memberships.id, result.membership.id));
    await set(parsed.data.on);
    if (!(await syncTenantAccess(result.tenant.id))) {
      // Security: a failed push can have reached the coordinator in part. Never show more protection than it gives.
      await set(false);
      sendNotApplied(res);
      return;
    }
    logAudit({
      tenantId: result.tenant.id,
      actorUserId: authUserId(req),
      action: "own_device_approval_changed",
      targetType: "membership",
      targetId: result.membership.id,
      metadata: { on: parsed.data.on },
    });
    res.json({ on: parsed.data.on, locked: false });
  },
);

/**
 * Removes every device of a member and revokes every key of that member. The member stays a member.
 * A member does this for themselves; the originator or a `manage_devices` holder does it for any member.
 * It only removes access, so lockdown does not block it.
 */
deviceHoldsRouter.post(
  "/api/tenants/:tenantId/members/:userId/devices/invalidate",
  requireAuth,
  tenantGuard(),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const targetId = param(req, "userId");
    const result = tenantCtx(res);
    const userId = authUserId(req);
    if (targetId !== userId && !hasPermission(result.membership, result.role, "manage_devices", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
    const [target] = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, targetId)));
    if (!target) {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    const out = await revokeMemberAccess({ tenantId, client: getCoordinatorClient(result.tenant), userId: targetId });
    await syncTenantAccess(tenantId);
    logAudit({
      tenantId,
      actorUserId: userId,
      action: "devices_invalidated",
      targetType: "user",
      targetId,
      metadata: { devicesDeleted: out.devicesDeleted, keysRevoked: out.keysRevoked, errors: out.errors },
    });
    if (out.errors.length > 0) {
      res.status(502).json({ error: "Some devices or keys could not be removed. Try again", ...out });
      return;
    }
    res.json({ status: "invalidated", devicesDeleted: out.devicesDeleted, keysRevoked: out.keysRevoked });
  },
);
