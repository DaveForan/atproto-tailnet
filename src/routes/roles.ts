/**
 * @module routes/roles
 * Role CRUD with permission chip toggling, role assignment and default-role
 * selection. Every grant is checked with `missingPermissions` (no escalation).
 */

import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { tenants, memberships, roles } from "../db/schema.js";
import { requireAuth, param, missingPermissions, permissionsAbove, rolePermissions, authUserId } from "./helpers.js";
import { tenantGuard, tenantCtx } from "./guard.js";
import { logAudit } from "../audit/log.js";
import { stepUpForSession } from "../auth/step-up.js";
import { permissionsSchema } from "../members/permissions.js";
import { parseBody } from "./validation.js";

export const rolesRouter = Router({ caseSensitive: true });

const roleBody = z.object({
  name: z.string().min(1).max(50),
  description: z.string().max(200).optional(),
  permissions: permissionsSchema,
});

const roleUpdateBody = z.object({
  name: z.string().min(1).max(50).optional(),
  description: z.string().max(200).optional(),
  permissions: permissionsSchema.optional(),
});

const assignRoleBody = z.object({
  roleId: z.string().uuid(),
});

const defaultRoleBody = z.object({
  roleId: z.string().uuid(),
});

// ── Roles CRUD ──────────────────────────────────────────────────────

rolesRouter.get(
  "/api/tenants/:tenantId/roles",
  requireAuth,
  tenantGuard(),
  async (req, res) => {

    const tenantRoles = await db
      .select()
      .from(roles)
      .where(eq(roles.tenantId, param(req, "tenantId")))
      .orderBy(roles.createdAt)
      .limit(200);

    res.json(tenantRoles);
  },
);

rolesRouter.post(
  "/api/tenants/:tenantId/roles",
  requireAuth,
  stepUpForSession,
  tenantGuard({ permission: "manage_roles" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = tenantCtx(res);

    const parsed = parseBody(roleBody, req, res);
    if (!parsed) return;

    // Anti-escalation: a caller may only grant permissions they effectively hold
    const lacking = missingPermissions(result.membership, result.role, parsed.data.permissions, req);
    if (lacking.length > 0) {
      res.status(403).json({ error: "Cannot grant permissions you do not hold", permissions: lacking });
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

rolesRouter.patch(
  "/api/tenants/:tenantId/roles/:roleId",
  requireAuth,
  stepUpForSession,
  tenantGuard({ permission: "manage_roles" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const roleId = param(req, "roleId");
    const result = tenantCtx(res);

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

    const parsed = parseBody(roleUpdateBody, req, res);
    if (!parsed) return;

    // System roles cannot be renamed
    if (targetRole.isSystem && parsed.data.name && parsed.data.name !== targetRole.name) {
      res.status(403).json({ error: "Cannot rename a system role" });
      return;
    }

    if (parsed.data.permissions !== undefined) {
      // Removing permissions demotes every holder, so the role must not outrank the caller.
      const above = permissionsAbove(result.membership, result.role, targetRole.permissions as string[], req);
      if (above.length > 0) {
        res.status(403).json({ error: "Cannot change a role with permissions you do not hold", permissions: above });
        return;
      }
      const existing = new Set(targetRole.permissions as string[]);
      const added = parsed.data.permissions.filter((p) => !existing.has(p));
      const lacking = missingPermissions(result.membership, result.role, added, req);
      if (lacking.length > 0) {
        res.status(403).json({ error: "Cannot grant permissions you do not hold", permissions: lacking });
        return;
      }
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

rolesRouter.delete(
  "/api/tenants/:tenantId/roles/:roleId",
  requireAuth,
  stepUpForSession,
  tenantGuard({ permission: "manage_roles" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const roleId = param(req, "roleId");
    const result = tenantCtx(res);

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

    const above = permissionsAbove(result.membership, result.role, targetRole.permissions as string[], req);
    if (above.length > 0) {
      res.status(403).json({ error: "Cannot delete a role with permissions you do not hold", permissions: above });
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

    // Anti-escalation: holders (possibly the caller) move to the default role,
    // so the caller must already hold everything the default role grants.
    if (tenant.defaultRoleId) {
      const [defaultRole] = await db
        .select()
        .from(roles)
        .where(and(eq(roles.id, tenant.defaultRoleId), eq(roles.tenantId, tenantId)));
      const lacking = missingPermissions(
        result.membership,
        result.role,
        (defaultRole?.permissions as string[] | undefined) ?? [],
        req,
      );
      if (lacking.length > 0) {
        res.status(403).json({
          error: "Deleting this role would move its members to a default role with permissions you do not hold",
          permissions: lacking,
        });
        return;
      }
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

rolesRouter.put(
  "/api/tenants/:tenantId/members/:userId/role",
  requireAuth,
  stepUpForSession,
  tenantGuard({ permission: "manage_roles" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const targetUserId = param(req, "userId");
    const result = tenantCtx(res);

    const parsed = parseBody(assignRoleBody, req, res);
    if (!parsed) return;

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

    const above = permissionsAbove(
      result.membership,
      result.role,
      await rolePermissions(tenantId, targetMembership.roleId),
      req,
    );
    if (above.length > 0) {
      res.status(403).json({ error: "Cannot change the role of a member with permissions you do not hold", permissions: above });
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

    // Anti-escalation: the assigned role's permissions must be a subset of the caller's
    const lacking = missingPermissions(
      result.membership,
      result.role,
      targetRole.permissions as string[],
      req,
    );
    if (lacking.length > 0) {
      res.status(403).json({ error: "Cannot assign a role with permissions you do not hold", permissions: lacking });
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

rolesRouter.patch(
  "/api/tenants/:tenantId/default-role",
  requireAuth,
  stepUpForSession,
  tenantGuard({ permission: "manage_roles" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = tenantCtx(res);

    const parsed = parseBody(defaultRoleBody, req, res);
    if (!parsed) return;

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

    // Anti-escalation: new members (and holders of deleted roles) get the
    // default role, so it may only grant permissions the caller holds.
    const lacking = missingPermissions(
      result.membership,
      result.role,
      targetRole.permissions as string[],
      req,
    );
    if (lacking.length > 0) {
      res.status(403).json({ error: "Cannot make a role with permissions you do not hold the default", permissions: lacking });
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
