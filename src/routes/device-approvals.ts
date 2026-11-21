/**
 * @module routes/device-approvals
 * Device approval queue: list (managers and own), approve (issues the key)
 * and reject.
 */

import { Router } from "express";
import { eq, and, desc, lt } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, deviceApprovals } from "../db/schema.js";
import { getControlClient } from "../orchestrator/control-client.js";
import { requireAuth, param, authUserId } from "./helpers.js";
import { isDeviceLocked } from "../access/admission.js";
import { tenantGuard, tenantCtx } from "./guard.js";
import { logAudit } from "../audit/log.js";
import { stepUpForSession } from "../auth/step-up.js";
import { logger } from "../logger.js";
import { tenantLoginServerFor } from "../orchestrator/hostnames.js";
import { enforceDeviceLimit } from "./limits.js";
import { issueMemberKey } from "../access/keys.js";

export const deviceApprovalsRouter = Router({ caseSensitive: true });

// ── Device approvals ────────────────────────────────────────────────

async function expireStalePending(tenantId: string): Promise<void> {
  await db
    .update(deviceApprovals)
    .set({ status: "expired" })
    .where(
      and(
        eq(deviceApprovals.tenantId, tenantId),
        eq(deviceApprovals.status, "pending"),
        lt(deviceApprovals.expiresAt, new Date()),
      ),
    );
}

deviceApprovalsRouter.get(
  "/api/tenants/:tenantId/device-approvals",
  requireAuth,
  tenantGuard({ permission: "approve_devices" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");

    await expireStalePending(tenantId);

    const rows = await db
      .select({
        id: deviceApprovals.id,
        requesterId: deviceApprovals.requesterId,
        requesterHandle: users.handle,
        requesterDisplayName: users.displayName,
        hsUsername: deviceApprovals.hsUsername,
        status: deviceApprovals.status,
        requestedAt: deviceApprovals.requestedAt,
        reviewedAt: deviceApprovals.reviewedAt,
        expiresAt: deviceApprovals.expiresAt,
      })
      .from(deviceApprovals)
      .innerJoin(users, eq(deviceApprovals.requesterId, users.id))
      .where(eq(deviceApprovals.tenantId, tenantId))
      .orderBy(desc(deviceApprovals.requestedAt))
      .limit(200);

    res.json(rows);
  },
);

deviceApprovalsRouter.get(
  "/api/tenants/:tenantId/device-approvals/mine",
  requireAuth,
  tenantGuard(),
  async (req, res) => {
    const tenantId = param(req, "tenantId");

    await expireStalePending(tenantId);

    const rows = await db
      .select()
      .from(deviceApprovals)
      .where(
        and(
          eq(deviceApprovals.tenantId, tenantId),
          eq(deviceApprovals.requesterId, authUserId(req)),
        ),
      )
      .orderBy(desc(deviceApprovals.requestedAt))
      .limit(200);

    res.json(
      rows.map((r) => ({
        id: r.id,
        status: r.status,
        requestedAt: r.requestedAt,
        reviewedAt: r.reviewedAt,
        expiresAt: r.expiresAt,
        preAuthKey: r.status === "approved" ? r.preAuthKey : undefined,
        command: r.status === "approved" ? r.command : undefined,
      })),
    );
  },
);

deviceApprovalsRouter.post(
  "/api/tenants/:tenantId/device-approvals/:approvalId/approve",
  requireAuth,
  stepUpForSession,
  tenantGuard({ permission: "approve_devices", notLockedDown: true }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const approvalId = param(req, "approvalId");
    const result = tenantCtx(res);

    const [approval] = await db
      .select()
      .from(deviceApprovals)
      .where(
        and(
          eq(deviceApprovals.id, approvalId),
          eq(deviceApprovals.tenantId, tenantId),
        ),
      );

    if (!approval) {
      res.status(404).json({ error: "Approval request not found" });
      return;
    }
    if (approval.status !== "pending") {
      res.status(409).json({ error: `Request already ${approval.status}` });
      return;
    }
    if (approval.expiresAt < new Date()) {
      await db
        .update(deviceApprovals)
        .set({ status: "expired" })
        .where(eq(deviceApprovals.id, approvalId));
      res.status(410).json({ error: "Request has expired" });
      return;
    }

    // The requester may have been device-locked after filing the request
    if (await isDeviceLocked(tenantId, approval.requesterId)) {
      res.status(409).json({ error: "Requester is locked to specific devices — remove the lock first" });
      return;
    }

    const client = getControlClient(result.tenant);
    if (!(await enforceDeviceLimit(res, result.tenant, client))) return;

    try {
      const authKey = await issueMemberKey({
        tenant: result.tenant,
        client,
        userId: approval.requesterId,
        hsUsername: approval.hsUsername,
      });
      const loginServer = await tenantLoginServerFor(result.tenant);
      const command = `tailscale up --login-server ${loginServer} --authkey ${authKey.key}`;

      await db
        .update(deviceApprovals)
        .set({
          status: "approved",
          preAuthKey: authKey.key,
          command,
          reviewedById: authUserId(req),
          reviewedAt: new Date(),
        })
        .where(eq(deviceApprovals.id, approvalId));

      logAudit({
        tenantId,
        actorUserId: authUserId(req),
        action: "device_approved",
        targetType: "device_approval",
        targetId: approvalId,
        metadata: { requesterId: approval.requesterId },
      });

      res.json({ status: "approved", preAuthKey: authKey.key, command });
    } catch (err) {
      logger.error({ err }, "failed to generate auth key for approval");
      res.status(502).json({ error: "Failed to generate auth key" });
    }
  },
);

deviceApprovalsRouter.post(
  "/api/tenants/:tenantId/device-approvals/:approvalId/reject",
  requireAuth,
  tenantGuard({ permission: "approve_devices" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const approvalId = param(req, "approvalId");

    const [approval] = await db
      .select()
      .from(deviceApprovals)
      .where(
        and(
          eq(deviceApprovals.id, approvalId),
          eq(deviceApprovals.tenantId, tenantId),
          eq(deviceApprovals.status, "pending"),
        ),
      );

    if (!approval) {
      res.status(404).json({ error: "Pending approval not found" });
      return;
    }

    await db
      .update(deviceApprovals)
      .set({
        status: "rejected",
        reviewedById: authUserId(req),
        reviewedAt: new Date(),
      })
      .where(eq(deviceApprovals.id, approvalId));

    logAudit({
      tenantId,
      actorUserId: authUserId(req),
      action: "device_rejected",
      targetType: "device_approval",
      targetId: approvalId,
      metadata: { requesterId: approval.requesterId },
    });

    res.json({ status: "rejected" });
  },
);
