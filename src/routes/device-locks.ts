/**
 * @module routes/device-locks
 * Device locks (Headscale mode): lock a member to current devices (self or `lock_devices`, step-up), unlock, read.
 */

import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { memberships, users, deviceLocks } from "../db/schema.js";
import { getControlClient, useCoordinator } from "../orchestrator/control-client.js";
import {
  requireAuth,
  param,
  hasPermission,
  toHsUsername,
  authUserId,
} from "./helpers.js";
import { tenantGuard, tenantCtx } from "./guard.js";
import { logAudit } from "../audit/log.js";
import { stepUpForSession } from "../auth/step-up.js";
import { logger } from "../logger.js";
import { parseBody } from "./validation.js";

export const deviceLocksRouter = Router({ caseSensitive: true });

/** Coordinator mode has the per-member machine lock (ADR-0035 §2) instead. */
const COORDINATOR_MODE_ERROR = "Device locks exist only in Headscale mode. Use the machine lock in coordinator mode.";

const deviceLockBody = z.object({
  userId: z.string().uuid(),
});

deviceLocksRouter.post(
  "/api/tenants/:tenantId/device-locks",
  requireAuth,
  stepUpForSession,
  // No lockdown check: a lock only reduces access, which lockdown must allow.
  tenantGuard(),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = tenantCtx(res);
    const parsed = parseBody(deviceLockBody, req, res);
    if (!parsed) return;

    const targetUserId = parsed.data.userId;
    const isSelf = targetUserId === authUserId(req);
    if (!isSelf && !hasPermission(result.membership, result.role, "lock_devices", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    if (useCoordinator) {
      res.status(501).json({ error: COORDINATOR_MODE_ERROR });
      return;
    }

    const [targetMembership] = await db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          eq(memberships.userId, targetUserId),
        ),
      );

    if (!targetMembership) {
      res.status(404).json({ error: "Member not found" });
      return;
    }

    const [targetUser] = await db
      .select()
      .from(users)
      .where(eq(users.id, targetUserId));

    const hsUsername =
      targetMembership.isOriginator
        ? "owner"
        : toHsUsername(targetUser.handle);

    try {
      const client = getControlClient(result.tenant);
      const nodes = await client.listNodes();
      const userNodes = nodes.filter((n) => n.user?.name === hsUsername);

      if (userNodes.length === 0) {
        res.status(400).json({ error: "No devices found to lock" });
        return;
      }

      const lockValues = userNodes
        .filter((n) => n.machineKey)
        .map((n) => ({
          membershipId: targetMembership.id,
          machineKey: n.machineKey!,
          nodeName: n.givenName || n.name,
        }));

      if (lockValues.length > 0) {
        await db
          .delete(deviceLocks)
          .where(eq(deviceLocks.membershipId, targetMembership.id));
        await db.insert(deviceLocks).values(lockValues);
      }

      logAudit({
        tenantId,
        actorUserId: authUserId(req),
        action: "device_locked",
        targetType: "member",
        targetId: targetUserId,
        metadata: { deviceCount: lockValues.length },
      });

      res.json({
        locked: true,
        devices: lockValues.map((l) => ({
          machineKey: l.machineKey,
          nodeName: l.nodeName,
        })),
      });
    } catch (err) {
      logger.error({ err }, "failed to lock devices");
      res.status(502).json({ error: "Failed to read devices from Headscale" });
    }
  },
);

deviceLocksRouter.delete(
  "/api/tenants/:tenantId/device-locks",
  requireAuth,
  stepUpForSession,
  // Removing a lock — including your own — requires lock_devices; otherwise
  // a locked member could simply unlock themselves.
  tenantGuard({ permission: "lock_devices" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");

    const parsed = parseBody(deviceLockBody, req, res);
    if (!parsed) return;
    const targetUserId = parsed.data.userId;

    if (useCoordinator) {
      res.status(501).json({ error: COORDINATOR_MODE_ERROR });
      return;
    }

    const [targetMembership] = await db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          eq(memberships.userId, targetUserId),
        ),
      );

    if (!targetMembership) {
      res.status(404).json({ error: "Member not found" });
      return;
    }

    await db
      .delete(deviceLocks)
      .where(eq(deviceLocks.membershipId, targetMembership.id));

    logAudit({
      tenantId,
      actorUserId: authUserId(req),
      action: "device_unlocked",
      targetType: "member",
      targetId: targetUserId,
    });

    res.json({ locked: false });
  },
);

deviceLocksRouter.get(
  "/api/tenants/:tenantId/device-locks/:userId",
  requireAuth,
  tenantGuard(),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const targetUserId = param(req, "userId");
    const result = tenantCtx(res);

    const isSelf = targetUserId === authUserId(req);
    if (!isSelf && !hasPermission(result.membership, result.role, "lock_devices", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    const [targetMembership] = await db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          eq(memberships.userId, targetUserId),
        ),
      );

    if (!targetMembership) {
      res.status(404).json({ error: "Member not found" });
      return;
    }

    const locks = await db
      .select()
      .from(deviceLocks)
      .where(eq(deviceLocks.membershipId, targetMembership.id));

    res.json({
      locked: locks.length > 0,
      devices: locks.map((l) => ({
        machineKey: l.machineKey,
        nodeName: l.nodeName,
        createdAt: l.createdAt,
      })),
    });
  },
);
