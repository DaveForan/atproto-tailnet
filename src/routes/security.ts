import { Router } from "express";
import { eq, and, desc, lt, count } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import {
  tenants,
  memberships,
  users,
  deviceApprovals,
  deviceLocks,
  auditLogs,
} from "../db/schema.js";
import { HeadscaleApiClient } from "../orchestrator/headscale-api.js";
import {
  requireAuth,
  param,
  getTenantForUser,
  hasPermission,
  isLockedDown,
  toHsUsername,
  tenantLoginServer,
} from "./helpers.js";
import { logAudit } from "./audit.js";

export const securityRouter = Router();

const settingsBody = z.object({
  requireDeviceApproval: z.boolean().optional(),
  lockdownMode: z.boolean().optional(),
});

const permissionsBody = z.object({
  canInvite: z.boolean().optional(),
  canKick: z.boolean().optional(),
});

const deviceLockBody = z.object({
  userId: z.string().uuid(),
});

// ── Tenant settings ─────────────────────────────────────────────────

/** Returns the tenant's security settings. Any member can read. */
securityRouter.get(
  "/api/tenants/:tenantId/settings",
  requireAuth,
  async (req, res) => {
    const result = await getTenantForUser(
      param(req, "tenantId"),
      req.session.userId!,
    );
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    res.json({
      requireDeviceApproval: result.tenant.requireDeviceApproval,
      lockdownMode: result.tenant.lockdownMode,
    });
  },
);

/** Updates tenant security settings. Owner only. */
securityRouter.patch(
  "/api/tenants/:tenantId/settings",
  requireAuth,
  async (req, res) => {
    const result = await getTenantForUser(
      param(req, "tenantId"),
      req.session.userId!,
    );
    if (!result || result.membership.role !== "owner") {
      res.status(403).json({ error: "Only the tenant owner can change settings" });
      return;
    }

    const parsed = settingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
      return;
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (parsed.data.requireDeviceApproval !== undefined) {
      updates.requireDeviceApproval = parsed.data.requireDeviceApproval;
      logAudit({
        tenantId: result.tenant.id,
        actorUserId: req.session.userId!,
        action: "tenant_settings_updated",
        targetType: "tenant",
        targetId: result.tenant.id,
        metadata: { requireDeviceApproval: parsed.data.requireDeviceApproval },
      });
    }

    if (parsed.data.lockdownMode !== undefined) {
      updates.lockdownMode = parsed.data.lockdownMode;
      logAudit({
        tenantId: result.tenant.id,
        actorUserId: req.session.userId!,
        action: parsed.data.lockdownMode ? "lockdown_enabled" : "lockdown_disabled",
        targetType: "tenant",
        targetId: result.tenant.id,
      });
    }

    await db
      .update(tenants)
      .set(updates)
      .where(eq(tenants.id, result.tenant.id));

    const [updated] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, result.tenant.id));

    res.json({
      requireDeviceApproval: updated.requireDeviceApproval,
      lockdownMode: updated.lockdownMode,
    });
  },
);

// ── Member permissions ──────────────────────────────────────────────

/** Toggles per-member invite/kick permissions. Owner only. */
securityRouter.patch(
  "/api/tenants/:tenantId/members/:userId/permissions",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const targetUserId = param(req, "userId");

    const result = await getTenantForUser(tenantId, req.session.userId!);
    if (!result || result.membership.role !== "owner") {
      res.status(403).json({ error: "Only the tenant owner can change permissions" });
      return;
    }

    const parsed = permissionsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
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

    if (targetMembership.role === "owner") {
      res.status(400).json({ error: "Cannot modify owner permissions" });
      return;
    }

    const updates: Record<string, unknown> = {};
    if (parsed.data.canInvite !== undefined) updates.canInvite = parsed.data.canInvite;
    if (parsed.data.canKick !== undefined) updates.canKick = parsed.data.canKick;

    if (Object.keys(updates).length === 0) {
      res.json({
        userId: targetUserId,
        canInvite: targetMembership.canInvite,
        canKick: targetMembership.canKick,
      });
      return;
    }

    await db
      .update(memberships)
      .set(updates)
      .where(eq(memberships.id, targetMembership.id));

    logAudit({
      tenantId,
      actorUserId: req.session.userId!,
      action: "member_permissions_updated",
      targetType: "member",
      targetId: targetUserId,
      metadata: updates,
    });

    const [refreshed] = await db
      .select()
      .from(memberships)
      .where(eq(memberships.id, targetMembership.id));

    res.json({
      userId: targetUserId,
      canInvite: refreshed.canInvite,
      canKick: refreshed.canKick,
    });
  },
);

// ── Device approvals ────────────────────────────────────────────────

/** Marks expired pending approvals as expired (lazy). */
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

/** Lists pending device approvals. Owner or canInvite. */
securityRouter.get(
  "/api/tenants/:tenantId/device-approvals",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, req.session.userId!);
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }
    if (!hasPermission(result.membership, "invite")) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

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
      .orderBy(desc(deviceApprovals.requestedAt));

    res.json(rows);
  },
);

/** Lists the current user's own device approval requests. */
securityRouter.get(
  "/api/tenants/:tenantId/device-approvals/mine",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, req.session.userId!);
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    await expireStalePending(tenantId);

    const rows = await db
      .select()
      .from(deviceApprovals)
      .where(
        and(
          eq(deviceApprovals.tenantId, tenantId),
          eq(deviceApprovals.requesterId, req.session.userId!),
        ),
      )
      .orderBy(desc(deviceApprovals.requestedAt));

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

/** Approves a pending device request — generates a Headscale pre-auth key. */
securityRouter.post(
  "/api/tenants/:tenantId/device-approvals/:approvalId/approve",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const approvalId = param(req, "approvalId");

    const result = await getTenantForUser(tenantId, req.session.userId!);
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }
    if (!hasPermission(result.membership, "invite")) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

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

    try {
      const client = new HeadscaleApiClient(
        result.tenant.port,
        result.tenant.apiKey,
      );
      const authKey = await client.createPreAuthKey(approval.hsUsername);
      const loginServer = tenantLoginServer(result.tenant.slug);
      const command = `tailscale up --login-server ${loginServer} --authkey ${authKey.key}`;

      await db
        .update(deviceApprovals)
        .set({
          status: "approved",
          preAuthKey: authKey.key,
          command,
          reviewedById: req.session.userId!,
          reviewedAt: new Date(),
        })
        .where(eq(deviceApprovals.id, approvalId));

      logAudit({
        tenantId,
        actorUserId: req.session.userId!,
        action: "device_approved",
        targetType: "device_approval",
        targetId: approvalId,
        metadata: { requesterId: approval.requesterId },
      });

      res.json({ status: "approved", preAuthKey: authKey.key, command });
    } catch (err) {
      console.error("Failed to generate auth key for approval:", err);
      res.status(502).json({ error: "Failed to generate auth key" });
    }
  },
);

/** Rejects a pending device request. */
securityRouter.post(
  "/api/tenants/:tenantId/device-approvals/:approvalId/reject",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const approvalId = param(req, "approvalId");

    const result = await getTenantForUser(tenantId, req.session.userId!);
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }
    if (!hasPermission(result.membership, "invite")) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

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
        reviewedById: req.session.userId!,
        reviewedAt: new Date(),
      })
      .where(eq(deviceApprovals.id, approvalId));

    logAudit({
      tenantId,
      actorUserId: req.session.userId!,
      action: "device_rejected",
      targetType: "device_approval",
      targetId: approvalId,
      metadata: { requesterId: approval.requesterId },
    });

    res.json({ status: "rejected" });
  },
);

// ── Device locks ────────────────────────────────────────────────────

/** Locks a user's membership to their current Headscale devices. */
securityRouter.post(
  "/api/tenants/:tenantId/device-locks",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const parsed = deviceLockBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "userId is required" });
      return;
    }

    const result = await getTenantForUser(tenantId, req.session.userId!);
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const targetUserId = parsed.data.userId;
    const isSelf = targetUserId === req.session.userId;
    if (!isSelf && result.membership.role !== "owner") {
      res.status(403).json({ error: "Only the owner can lock other members' devices" });
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
      targetMembership.role === "owner"
        ? "owner"
        : toHsUsername(targetUser.handle);

    try {
      const client = new HeadscaleApiClient(
        result.tenant.port,
        result.tenant.apiKey,
      );
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
        actorUserId: req.session.userId!,
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
      console.error("Failed to lock devices:", err);
      res.status(502).json({ error: "Failed to read devices from Headscale" });
    }
  },
);

/** Removes all device locks for a user. */
securityRouter.delete(
  "/api/tenants/:tenantId/device-locks",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const parsed = deviceLockBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "userId is required" });
      return;
    }

    const result = await getTenantForUser(tenantId, req.session.userId!);
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const targetUserId = parsed.data.userId;
    const isSelf = targetUserId === req.session.userId;
    if (!isSelf && result.membership.role !== "owner") {
      res.status(403).json({ error: "Only the owner can unlock other members' devices" });
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
      actorUserId: req.session.userId!,
      action: "device_unlocked",
      targetType: "member",
      targetId: targetUserId,
    });

    res.json({ locked: false });
  },
);

/** Lists locked devices for a user. */
securityRouter.get(
  "/api/tenants/:tenantId/device-locks/:userId",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const targetUserId = param(req, "userId");

    const result = await getTenantForUser(tenantId, req.session.userId!);
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const isSelf = targetUserId === req.session.userId;
    if (!isSelf && result.membership.role !== "owner") {
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

// ── Audit log ───────────────────────────────────────────────────────

/** Paginated audit log. Owner only. */
securityRouter.get(
  "/api/tenants/:tenantId/audit-log",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, req.session.userId!);
    if (!result || result.membership.role !== "owner") {
      res.status(403).json({ error: "Only the tenant owner can view the audit log" });
      return;
    }

    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;
    const actionFilter = req.query.action as string | undefined;

    const conditions = [eq(auditLogs.tenantId, tenantId)];
    if (actionFilter) {
      conditions.push(eq(auditLogs.action, actionFilter as typeof auditLogs.action.enumValues[number]));
    }

    const [entries, [totalRow]] = await Promise.all([
      db
        .select({
          id: auditLogs.id,
          actorHandle: users.handle,
          actorDisplayName: users.displayName,
          action: auditLogs.action,
          targetType: auditLogs.targetType,
          targetId: auditLogs.targetId,
          metadata: auditLogs.metadata,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .innerJoin(users, eq(auditLogs.actorUserId, users.id))
        .where(and(...conditions))
        .orderBy(desc(auditLogs.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ total: count() })
        .from(auditLogs)
        .where(and(...conditions)),
    ]);

    res.json({ entries, total: totalRow.total });
  },
);
