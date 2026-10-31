/**
 * @module routes/security
 * Tenant security surface: settings (toggles for device approval, lockdown,
 * join requests, board, services, agent tokens), role CRUD with permission
 * chip toggling, role assignment, default-role selection, device approval
 * and rejection, device locks, join-request review, and paginated audit log.
 */

import { Router } from "express";
import { eq, and, desc, lt, count } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import {
  tenants,
  memberships,
  roles,
  users,
  deviceApprovals,
  joinRequests,
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
  authUserId,
} from "./helpers.js";
import { logAudit } from "./audit.js";
import { ALL_PERMISSIONS, type Permission } from "./permissions.js";

/**
 * Router for tenant settings, roles CRUD, role assignment, device approvals/locks,
 * join-request management, and audit log retrieval.
 */
export const securityRouter = Router();

const settingsBody = z.object({
  requireDeviceApproval: z.boolean().optional(),
  lockdownMode: z.boolean().optional(),
  allowJoinRequests: z.boolean().optional(),
  boardEnabled: z.boolean().optional(),
  maxBoardPosts: z.number().int().min(1).max(200).optional(),
  maxBoardPostsDisplayed: z.number().int().min(1).max(200).optional(),
  requireServiceApproval: z.boolean().optional(),
  requireServiceDeviceApproval: z.boolean().optional(),
  allowAgentTokens: z.boolean().optional(),
  allowMemberAgentTokens: z.boolean().optional(),
  hibernateAfterDays: z.number().int().min(0).max(365).optional(),
});

const roleBody = z.object({
  name: z.string().min(1).max(50),
  description: z.string().max(200).optional(),
  permissions: z.array(z.enum(ALL_PERMISSIONS as unknown as [string, ...string[]])),
});

const roleUpdateBody = z.object({
  name: z.string().min(1).max(50).optional(),
  description: z.string().max(200).optional(),
  permissions: z.array(z.enum(ALL_PERMISSIONS as unknown as [string, ...string[]])).optional(),
});

const assignRoleBody = z.object({
  roleId: z.string().uuid(),
});

const defaultRoleBody = z.object({
  roleId: z.string().uuid(),
});

const deviceLockBody = z.object({
  userId: z.string().uuid(),
});

// ── Permissions list ────────────────────────────────────────────────

securityRouter.get("/api/permissions", requireAuth, (_req, res) => {
  res.json(ALL_PERMISSIONS);
});

// ── Tenant settings ─────────────────────────────────────────────────

securityRouter.get(
  "/api/tenants/:tenantId/settings",
  requireAuth,
  async (req, res) => {
    const result = await getTenantForUser(
      param(req, "tenantId"),
      authUserId(req),
    );
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    res.json({
      requireDeviceApproval: result.tenant.requireDeviceApproval,
      lockdownMode: result.tenant.lockdownMode,
      allowJoinRequests: result.tenant.allowJoinRequests,
      boardEnabled: result.tenant.boardEnabled,
      maxBoardPosts: result.tenant.maxBoardPosts,
      maxBoardPostsDisplayed: result.tenant.maxBoardPostsDisplayed,
      requireServiceApproval: result.tenant.requireServiceApproval,
      requireServiceDeviceApproval: result.tenant.requireServiceDeviceApproval,
      allowAgentTokens: result.tenant.allowAgentTokens,
      allowMemberAgentTokens: result.tenant.allowMemberAgentTokens,
      hibernateAfterDays: result.tenant.hibernateAfterDays,
      lastActivityAt: result.tenant.lastActivityAt,
      defaultRoleId: result.tenant.defaultRoleId,
    });
  },
);

securityRouter.patch(
  "/api/tenants/:tenantId/settings",
  requireAuth,
  async (req, res) => {
    const result = await getTenantForUser(
      param(req, "tenantId"),
      authUserId(req),
    );
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }
    if (!hasPermission(result.membership, result.role, "manage_settings", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
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
        actorUserId: authUserId(req),
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
        actorUserId: authUserId(req),
        action: parsed.data.lockdownMode ? "lockdown_enabled" : "lockdown_disabled",
        targetType: "tenant",
        targetId: result.tenant.id,
      });
    }

    if (parsed.data.allowJoinRequests !== undefined) {
      updates.allowJoinRequests = parsed.data.allowJoinRequests;
      logAudit({
        tenantId: result.tenant.id,
        actorUserId: authUserId(req),
        action: parsed.data.allowJoinRequests ? "join_requests_enabled" : "join_requests_disabled",
        targetType: "tenant",
        targetId: result.tenant.id,
      });
    }

    if (parsed.data.boardEnabled !== undefined) {
      updates.boardEnabled = parsed.data.boardEnabled;
      logAudit({
        tenantId: result.tenant.id,
        actorUserId: authUserId(req),
        action: parsed.data.boardEnabled ? "board_enabled" : "board_disabled",
        targetType: "tenant",
        targetId: result.tenant.id,
      });
    }

    if (parsed.data.maxBoardPosts !== undefined || parsed.data.maxBoardPostsDisplayed !== undefined) {
      if (parsed.data.maxBoardPosts !== undefined) updates.maxBoardPosts = parsed.data.maxBoardPosts;
      if (parsed.data.maxBoardPostsDisplayed !== undefined) updates.maxBoardPostsDisplayed = parsed.data.maxBoardPostsDisplayed;
      logAudit({
        tenantId: result.tenant.id,
        actorUserId: authUserId(req),
        action: "board_settings_updated",
        targetType: "tenant",
        targetId: result.tenant.id,
        metadata: { maxBoardPosts: parsed.data.maxBoardPosts, maxBoardPostsDisplayed: parsed.data.maxBoardPostsDisplayed },
      });
    }

    if (parsed.data.requireServiceApproval !== undefined) {
      updates.requireServiceApproval = parsed.data.requireServiceApproval;
      logAudit({
        tenantId: result.tenant.id,
        actorUserId: authUserId(req),
        action: "tenant_settings_updated",
        targetType: "tenant",
        targetId: result.tenant.id,
        metadata: { requireServiceApproval: parsed.data.requireServiceApproval },
      });
    }

    if (parsed.data.requireServiceDeviceApproval !== undefined) {
      updates.requireServiceDeviceApproval = parsed.data.requireServiceDeviceApproval;
      logAudit({
        tenantId: result.tenant.id,
        actorUserId: authUserId(req),
        action: "tenant_settings_updated",
        targetType: "tenant",
        targetId: result.tenant.id,
        metadata: { requireServiceDeviceApproval: parsed.data.requireServiceDeviceApproval },
      });
    }

    if (parsed.data.allowAgentTokens !== undefined) {
      updates.allowAgentTokens = parsed.data.allowAgentTokens;
      logAudit({
        tenantId: result.tenant.id,
        actorUserId: authUserId(req),
        action: "tenant_settings_updated",
        targetType: "tenant",
        targetId: result.tenant.id,
        metadata: { allowAgentTokens: parsed.data.allowAgentTokens },
      });
    }

    if (parsed.data.allowMemberAgentTokens !== undefined) {
      updates.allowMemberAgentTokens = parsed.data.allowMemberAgentTokens;
      logAudit({
        tenantId: result.tenant.id,
        actorUserId: authUserId(req),
        action: "tenant_settings_updated",
        targetType: "tenant",
        targetId: result.tenant.id,
        metadata: { allowMemberAgentTokens: parsed.data.allowMemberAgentTokens },
      });
    }

    if (parsed.data.hibernateAfterDays !== undefined) {
      updates.hibernateAfterDays = parsed.data.hibernateAfterDays;
      logAudit({
        tenantId: result.tenant.id,
        actorUserId: authUserId(req),
        action: "tenant_settings_updated",
        targetType: "tenant",
        targetId: result.tenant.id,
        metadata: { hibernateAfterDays: parsed.data.hibernateAfterDays },
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
      allowJoinRequests: updated.allowJoinRequests,
      boardEnabled: updated.boardEnabled,
      maxBoardPosts: updated.maxBoardPosts,
      maxBoardPostsDisplayed: updated.maxBoardPostsDisplayed,
      requireServiceApproval: updated.requireServiceApproval,
      requireServiceDeviceApproval: updated.requireServiceDeviceApproval,
      allowAgentTokens: updated.allowAgentTokens,
      allowMemberAgentTokens: updated.allowMemberAgentTokens,
      hibernateAfterDays: updated.hibernateAfterDays,
      lastActivityAt: updated.lastActivityAt,
      defaultRoleId: updated.defaultRoleId,
    });
  },
);

// ── Roles CRUD ──────────────────────────────────────────────────────

securityRouter.get(
  "/api/tenants/:tenantId/roles",
  requireAuth,
  async (req, res) => {
    const result = await getTenantForUser(
      param(req, "tenantId"),
      authUserId(req),
    );
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const tenantRoles = await db
      .select()
      .from(roles)
      .where(eq(roles.tenantId, param(req, "tenantId")))
      .orderBy(roles.createdAt)
      .limit(200);

    res.json(tenantRoles);
  },
);

securityRouter.post(
  "/api/tenants/:tenantId/roles",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }
    if (!hasPermission(result.membership, result.role, "manage_roles", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    const parsed = roleBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
      return;
    }

    const [existing] = await db
      .select()
      .from(roles)
      .where(and(eq(roles.tenantId, tenantId), eq(roles.name, parsed.data.name)));

    if (existing) {
      res.status(409).json({ error: "A role with that name already exists" });
      return;
    }

    const [created] = await db
      .insert(roles)
      .values({
        tenantId,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        permissions: parsed.data.permissions,
      })
      .returning();

    logAudit({
      tenantId,
      actorUserId: authUserId(req),
      action: "role_created",
      targetType: "role",
      targetId: created.id,
      metadata: { name: parsed.data.name, permissions: parsed.data.permissions },
    });

    res.status(201).json(created);
  },
);

securityRouter.patch(
  "/api/tenants/:tenantId/roles/:roleId",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const roleId = param(req, "roleId");

    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }
    if (!hasPermission(result.membership, result.role, "manage_roles", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    const [targetRole] = await db
      .select()
      .from(roles)
      .where(and(eq(roles.id, roleId), eq(roles.tenantId, tenantId)));

    if (!targetRole) {
      res.status(404).json({ error: "Role not found" });
      return;
    }

    // System originator role's permissions cannot be changed
    if (targetRole.isSystem && targetRole.name === "originator") {
      res.status(403).json({ error: "Cannot modify the originator role" });
      return;
    }

    const parsed = roleUpdateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
      return;
    }

    // System roles cannot be renamed
    if (targetRole.isSystem && parsed.data.name && parsed.data.name !== targetRole.name) {
      res.status(403).json({ error: "Cannot rename a system role" });
      return;
    }

    if (parsed.data.name && parsed.data.name !== targetRole.name) {
      const [dup] = await db
        .select()
        .from(roles)
        .where(and(eq(roles.tenantId, tenantId), eq(roles.name, parsed.data.name)));
      if (dup) {
        res.status(409).json({ error: "A role with that name already exists" });
        return;
      }
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.description !== undefined) updates.description = parsed.data.description;
    if (parsed.data.permissions !== undefined) updates.permissions = parsed.data.permissions;

    await db
      .update(roles)
      .set(updates)
      .where(eq(roles.id, roleId));

    const [updated] = await db.select().from(roles).where(eq(roles.id, roleId));

    logAudit({
      tenantId,
      actorUserId: authUserId(req),
      action: "role_updated",
      targetType: "role",
      targetId: roleId,
      metadata: { changes: parsed.data },
    });

    res.json(updated);
  },
);

securityRouter.delete(
  "/api/tenants/:tenantId/roles/:roleId",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const roleId = param(req, "roleId");

    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }
    if (!hasPermission(result.membership, result.role, "manage_roles", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    const [targetRole] = await db
      .select()
      .from(roles)
      .where(and(eq(roles.id, roleId), eq(roles.tenantId, tenantId)));

    if (!targetRole) {
      res.status(404).json({ error: "Role not found" });
      return;
    }

    if (targetRole.isSystem) {
      res.status(403).json({ error: "Cannot delete a system role" });
      return;
    }

    // If this role is the default role, block deletion
    const [tenant] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, tenantId));

    if (tenant.defaultRoleId === roleId) {
      res.status(409).json({ error: "Cannot delete the default role — assign a different default first" });
      return;
    }

    // Reassign members to the tenant's default role (or null as last resort)
    await db
      .update(memberships)
      .set({ roleId: tenant.defaultRoleId })
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.roleId, roleId)));

    await db.delete(roles).where(eq(roles.id, roleId));

    logAudit({
      tenantId,
      actorUserId: authUserId(req),
      action: "role_deleted",
      targetType: "role",
      targetId: roleId,
      metadata: { name: targetRole.name },
    });

    res.json({ status: "deleted" });
  },
);

// ── Role assignment ─────────────────────────────────────────────────

securityRouter.put(
  "/api/tenants/:tenantId/members/:userId/role",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const targetUserId = param(req, "userId");

    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }
    if (!hasPermission(result.membership, result.role, "manage_roles", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    const parsed = assignRoleBody.safeParse(req.body);
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

    if (targetMembership.isOriginator) {
      res.status(403).json({ error: "Cannot change the originator's role" });
      return;
    }

    // Verify the role belongs to this tenant
    const [targetRole] = await db
      .select()
      .from(roles)
      .where(and(eq(roles.id, parsed.data.roleId), eq(roles.tenantId, tenantId)));

    if (!targetRole) {
      res.status(404).json({ error: "Role not found in this tenant" });
      return;
    }

    // Don't allow assigning the originator role to non-originators
    if (targetRole.isSystem && targetRole.name === "originator") {
      res.status(403).json({ error: "The originator role cannot be assigned" });
      return;
    }

    await db
      .update(memberships)
      .set({ roleId: parsed.data.roleId })
      .where(eq(memberships.id, targetMembership.id));

    logAudit({
      tenantId,
      actorUserId: authUserId(req),
      action: "member_role_changed",
      targetType: "member",
      targetId: targetUserId,
      metadata: { roleId: parsed.data.roleId, roleName: targetRole.name },
    });

    res.json({ userId: targetUserId, roleId: parsed.data.roleId, roleName: targetRole.name });
  },
);

// ── Default role ────────────────────────────────────────────────────

securityRouter.patch(
  "/api/tenants/:tenantId/default-role",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");

    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }
    if (!hasPermission(result.membership, result.role, "manage_roles", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    const parsed = defaultRoleBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
      return;
    }

    const [targetRole] = await db
      .select()
      .from(roles)
      .where(and(eq(roles.id, parsed.data.roleId), eq(roles.tenantId, tenantId)));

    if (!targetRole) {
      res.status(404).json({ error: "Role not found in this tenant" });
      return;
    }

    if (targetRole.isSystem && targetRole.name === "originator") {
      res.status(403).json({ error: "Cannot set originator as the default role" });
      return;
    }

    await db
      .update(tenants)
      .set({ defaultRoleId: parsed.data.roleId, updatedAt: new Date() })
      .where(eq(tenants.id, tenantId));

    logAudit({
      tenantId,
      actorUserId: authUserId(req),
      action: "default_role_changed",
      targetType: "role",
      targetId: parsed.data.roleId,
      metadata: { roleName: targetRole.name },
    });

    res.json({ defaultRoleId: parsed.data.roleId, roleName: targetRole.name });
  },
);

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

securityRouter.get(
  "/api/tenants/:tenantId/device-approvals",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }
    if (!hasPermission(result.membership, result.role, "approve_devices", req)) {
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
      .orderBy(desc(deviceApprovals.requestedAt))
      .limit(200);

    res.json(rows);
  },
);

securityRouter.get(
  "/api/tenants/:tenantId/device-approvals/mine",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
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

securityRouter.post(
  "/api/tenants/:tenantId/device-approvals/:approvalId/approve",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const approvalId = param(req, "approvalId");

    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }
    if (!hasPermission(result.membership, result.role, "approve_devices", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    if (isLockedDown(result.tenant)) {
      res.status(403).json({ error: "Tenant is in lockdown mode" });
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
      console.error("Failed to generate auth key for approval:", err);
      res.status(502).json({ error: "Failed to generate auth key" });
    }
  },
);

securityRouter.post(
  "/api/tenants/:tenantId/device-approvals/:approvalId/reject",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const approvalId = param(req, "approvalId");

    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }
    if (!hasPermission(result.membership, result.role, "approve_devices", req)) {
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

// ── Join requests ───────────────────────────────────────────────────

securityRouter.get(
  "/api/tenants/:tenantId/join-requests",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }
    if (!hasPermission(result.membership, result.role, "approve_joins", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    const rows = await db
      .select({
        id: joinRequests.id,
        requesterId: joinRequests.requesterId,
        requesterHandle: users.handle,
        requesterDisplayName: users.displayName,
        requesterAvatarUrl: users.avatarUrl,
        message: joinRequests.message,
        status: joinRequests.status,
        requestedAt: joinRequests.requestedAt,
        reviewedAt: joinRequests.reviewedAt,
      })
      .from(joinRequests)
      .innerJoin(users, eq(joinRequests.requesterId, users.id))
      .where(eq(joinRequests.tenantId, tenantId))
      .orderBy(desc(joinRequests.requestedAt))
      .limit(200);

    res.json(rows);
  },
);

securityRouter.post(
  "/api/tenants/:tenantId/join-requests/:requestId/approve",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const requestId = param(req, "requestId");

    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }
    if (!hasPermission(result.membership, result.role, "approve_joins", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    if (isLockedDown(result.tenant)) {
      res.status(403).json({ error: "Tenant is in lockdown mode" });
      return;
    }

    const [request] = await db
      .select()
      .from(joinRequests)
      .where(
        and(
          eq(joinRequests.id, requestId),
          eq(joinRequests.tenantId, tenantId),
          eq(joinRequests.status, "pending"),
        ),
      );

    if (!request) {
      res.status(404).json({ error: "Pending join request not found" });
      return;
    }

    const [requester] = await db
      .select()
      .from(users)
      .where(eq(users.id, request.requesterId));

    const hsUsername = toHsUsername(requester.handle);

    try {
      const client = new HeadscaleApiClient(
        result.tenant.port,
        result.tenant.apiKey,
      );
      await client.createUser(hsUsername);
    } catch {
      // User might already exist
    }

    await db.insert(memberships).values({
      userId: request.requesterId,
      tenantId,
      role: "member",
      roleId: result.tenant.defaultRoleId,
      isOriginator: false,
    }).onConflictDoNothing();

    await db
      .update(joinRequests)
      .set({
        status: "approved",
        reviewedById: authUserId(req),
        reviewedAt: new Date(),
      })
      .where(eq(joinRequests.id, requestId));

    logAudit({
      tenantId,
      actorUserId: authUserId(req),
      action: "join_request_approved",
      targetType: "join_request",
      targetId: requestId,
      metadata: { handle: requester.handle },
    });

    res.json({ status: "approved" });
  },
);

securityRouter.post(
  "/api/tenants/:tenantId/join-requests/:requestId/reject",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const requestId = param(req, "requestId");

    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }
    if (!hasPermission(result.membership, result.role, "approve_joins", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    const [request] = await db
      .select()
      .from(joinRequests)
      .where(
        and(
          eq(joinRequests.id, requestId),
          eq(joinRequests.tenantId, tenantId),
          eq(joinRequests.status, "pending"),
        ),
      );

    if (!request) {
      res.status(404).json({ error: "Pending join request not found" });
      return;
    }

    await db
      .update(joinRequests)
      .set({
        status: "rejected",
        reviewedById: authUserId(req),
        reviewedAt: new Date(),
      })
      .where(eq(joinRequests.id, requestId));

    logAudit({
      tenantId,
      actorUserId: authUserId(req),
      action: "join_request_rejected",
      targetType: "join_request",
      targetId: requestId,
      metadata: { requesterId: request.requesterId },
    });

    res.json({ status: "rejected" });
  },
);

// ── Device locks ────────────────────────────────────────────────────

securityRouter.post(
  "/api/tenants/:tenantId/device-locks",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const parsed = deviceLockBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
      return;
    }

    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const targetUserId = parsed.data.userId;
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

    const [targetUser] = await db
      .select()
      .from(users)
      .where(eq(users.id, targetUserId));

    const hsUsername =
      targetMembership.isOriginator
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
      console.error("Failed to lock devices:", err);
      res.status(502).json({ error: "Failed to read devices from Headscale" });
    }
  },
);

securityRouter.delete(
  "/api/tenants/:tenantId/device-locks",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const parsed = deviceLockBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
      return;
    }

    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const targetUserId = parsed.data.userId;
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

securityRouter.get(
  "/api/tenants/:tenantId/device-locks/:userId",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const targetUserId = param(req, "userId");

    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

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

// ── Audit log ───────────────────────────────────────────────────────

securityRouter.get(
  "/api/tenants/:tenantId/audit-log",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }
    if (!hasPermission(result.membership, result.role, "view_audit_log", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
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
