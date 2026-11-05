/**
 * @module routes/collectives
 * Hierarchical tenancy — create, list, detach, and eject sub-collectives.
 * Gated by "manage_sub_collectives" permission.
 */

import { Router } from "express";
import { z } from "zod";
import { eq, and, ne, sql, like } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants, memberships, roles } from "../db/schema.js";
import {
  requireAuth,
  param,
  getTenantForUser,
  hasPermission,
  authUserId,
} from "./helpers.js";
import { logAudit } from "./audit.js";
import { logger } from "../logger.js";

export const collectivesRouter = Router();

const SLUG_RE = /^[a-z0-9_]+$/;
const MAX_DEPTH = 5;

const createSubCollectiveBody = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(2).max(40).regex(SLUG_RE, "Slug must be lowercase alphanumeric + underscores only"),
});

const floorPolicyBody = z.object({
  requireDeviceApproval: z.boolean().optional(),
  lockdownMode: z.boolean().optional(),
  allowJoinRequests: z.boolean().optional(),
  maxBoardPosts: z.number().int().min(0).optional(),
});

/** List sub-collectives of a collective. */
collectivesRouter.get(
  "/api/tenants/:tenantId/collectives",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const children = await db
      .select({
        id: tenants.id,
        slug: tenants.slug,
        name: tenants.name,
        status: tenants.status,
        depth: tenants.depth,
        path: tenants.path,
        memberCount: sql<number>`(
          SELECT count(*)::int FROM memberships
          WHERE memberships.tenant_id = ${tenants.id}
        )`,
        createdAt: tenants.createdAt,
      })
      .from(tenants)
      .where(
        and(eq(tenants.parentId, tenantId), ne(tenants.status, "deleted")),
      )
      .orderBy(tenants.name)
      .limit(200);

    res.json({
      parentId: tenantId,
      parentPath: result.tenant.path,
      depth: result.tenant.depth,
      maxSubCollectives: result.tenant.maxSubCollectives,
      children,
    });
  },
);

/** Get the full ancestor chain for a collective. */
collectivesRouter.get(
  "/api/tenants/:tenantId/ancestors",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const ancestors: Array<{ id: string; slug: string; name: string; depth: number }> = [];
    let current = result.tenant;

    while (current.parentId) {
      const [parent] = await db
        .select({
          id: tenants.id,
          slug: tenants.slug,
          name: tenants.name,
          depth: tenants.depth,
          parentId: tenants.parentId,
        })
        .from(tenants)
        .where(eq(tenants.id, current.parentId));

      if (!parent) break;
      ancestors.unshift({ id: parent.id, slug: parent.slug, name: parent.name, depth: parent.depth });
      current = parent as typeof current;
    }

    res.json({ ancestors });
  },
);

/** Create a sub-collective under the given parent. */
collectivesRouter.post(
  "/api/tenants/:tenantId/collectives",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const userId = authUserId(req);
    const result = await getTenantForUser(tenantId, userId);
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "manage_sub_collectives", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    const parsed = createSubCollectiveBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
      return;
    }

    const { tenant } = result;

    if (tenant.depth >= MAX_DEPTH) {
      res.status(400).json({ error: `Maximum nesting depth (${MAX_DEPTH}) reached` });
      return;
    }

    if (tenant.maxSubCollectives > 0) {
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(tenants)
        .where(and(eq(tenants.parentId, tenantId), ne(tenants.status, "deleted")));

      if (count >= tenant.maxSubCollectives) {
        res.status(400).json({
          error: `Sub-collective limit reached (${tenant.maxSubCollectives})`,
        });
        return;
      }
    }

    const { name, slug } = parsed.data;

    const [existing] = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, slug));

    if (existing) {
      res.status(409).json({ error: "Slug already in use" });
      return;
    }

    const childPath = tenant.path ? `${tenant.path}.${slug}` : slug;
    const childDepth = tenant.depth + 1;

    try {
      const [child] = await db
        .insert(tenants)
        .values({
          name,
          slug,
          ownerUserId: userId,
          port: 0,
          apiKey: "",
          status: "provisioning",
          parentId: tenantId,
          path: childPath,
          depth: childDepth,
          maxSubCollectives: 10,
          ipv4Prefix: tenant.ipv4Prefix,
          ipv6Prefix: tenant.ipv6Prefix,
          ipAllocation: tenant.ipAllocation,
          planName: "free",
        })
        .returning();

      const [originatorRole] = await db
        .insert(roles)
        .values({
          tenantId: child.id,
          name: "originator",
          permissions: (await import("./permissions.js")).ALL_PERMISSIONS as unknown as string[],
          isSystem: true,
        })
        .returning();

      const [citizenRole] = await db
        .insert(roles)
        .values({
          tenantId: child.id,
          name: "citizen",
          permissions: [],
          isSystem: true,
        })
        .returning();

      await db
        .update(tenants)
        .set({ defaultRoleId: citizenRole.id, updatedAt: new Date() })
        .where(eq(tenants.id, child.id));

      await db.insert(memberships).values({
        userId,
        tenantId: child.id,
        roleId: originatorRole.id,
        isOriginator: true,
      });

      logAudit({
        tenantId,
        actorUserId: userId,
        action: "sub_collective_created",
        targetType: "tenant",
        targetId: child.id,
        metadata: { childSlug: slug, childName: name, depth: childDepth },
      });

      res.status(201).json({
        id: child.id,
        slug: child.slug,
        name: child.name,
        parentId: tenantId,
        path: childPath,
        depth: childDepth,
        status: child.status,
      });
    } catch (err) {
      logger.error({ tenantId, slug, err }, "failed to create sub-collective");
      res.status(500).json({ error: "Failed to create sub-collective" });
    }
  },
);

/** Detach a sub-collective (child declares independence). */
collectivesRouter.post(
  "/api/tenants/:tenantId/detach",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const userId = authUserId(req);
    const result = await getTenantForUser(tenantId, userId);
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!result.membership.isOriginator) {
      res.status(403).json({ error: "Only the originator can detach a collective" });
      return;
    }

    const { tenant } = result;
    if (!tenant.parentId) {
      res.status(400).json({ error: "Root collectives cannot be detached" });
      return;
    }

    const oldParentId = tenant.parentId;

    await db
      .update(tenants)
      .set({
        parentId: null,
        path: tenant.slug,
        depth: 0,
        floorPolicies: null,
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, tenantId));

    await rebuildDescendantPaths(tenantId, tenant.slug, 0);

    logAudit({
      tenantId: oldParentId,
      actorUserId: userId,
      action: "sub_collective_detached",
      targetType: "tenant",
      targetId: tenantId,
      metadata: { detachedSlug: tenant.slug },
    });

    res.json({ status: "detached", id: tenantId, newPath: tenant.slug, depth: 0 });
  },
);

/** Eject a sub-collective (parent removes child). */
collectivesRouter.post(
  "/api/tenants/:tenantId/collectives/:childId/eject",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const childId = param(req, "childId");
    const userId = authUserId(req);

    const result = await getTenantForUser(tenantId, userId);
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "manage_sub_collectives", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    const [child] = await db
      .select()
      .from(tenants)
      .where(and(eq(tenants.id, childId), eq(tenants.parentId, tenantId)));

    if (!child) {
      res.status(404).json({ error: "Sub-collective not found" });
      return;
    }

    await db
      .update(tenants)
      .set({
        parentId: null,
        path: child.slug,
        depth: 0,
        floorPolicies: null,
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, childId));

    await rebuildDescendantPaths(childId, child.slug, 0);

    logAudit({
      tenantId,
      actorUserId: userId,
      action: "sub_collective_ejected",
      targetType: "tenant",
      targetId: childId,
      metadata: { ejectedSlug: child.slug },
    });

    res.json({ status: "ejected", childId, newPath: child.slug });
  },
);

/** Update floor policies for sub-collectives. */
collectivesRouter.put(
  "/api/tenants/:tenantId/floor-policies",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const userId = authUserId(req);
    const result = await getTenantForUser(tenantId, userId);
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "manage_sub_collectives", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    const parsed = floorPolicyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
      return;
    }

    await db
      .update(tenants)
      .set({ floorPolicies: parsed.data, updatedAt: new Date() })
      .where(eq(tenants.id, tenantId));

    logAudit({
      tenantId,
      actorUserId: userId,
      action: "floor_policy_updated",
      targetType: "tenant",
      targetId: tenantId,
      metadata: parsed.data,
    });

    res.json({ status: "updated", floorPolicies: parsed.data });
  },
);

/** Get the full descendant tree for a collective. */
collectivesRouter.get(
  "/api/tenants/:tenantId/tree",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const { tenant } = result;
    const pathPrefix = tenant.path ? `${tenant.path}.` : `${tenant.slug}.`;

    const descendants = await db
      .select({
        id: tenants.id,
        slug: tenants.slug,
        name: tenants.name,
        status: tenants.status,
        parentId: tenants.parentId,
        path: tenants.path,
        depth: tenants.depth,
        maxSubCollectives: tenants.maxSubCollectives,
        memberCount: sql<number>`(
          SELECT count(*)::int FROM memberships
          WHERE memberships.tenant_id = ${tenants.id}
        )`,
        createdAt: tenants.createdAt,
      })
      .from(tenants)
      .where(
        and(
          like(tenants.path, `${pathPrefix}%`),
          ne(tenants.status, "deleted"),
        ),
      )
      .orderBy(tenants.depth, tenants.name)
      .limit(500);

    res.json({
      root: {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        path: tenant.path,
        depth: tenant.depth,
      },
      descendants,
      totalDescendants: descendants.length,
    });
  },
);

const quotaBody = z.object({
  maxDevices: z.number().int().min(0).optional(),
  maxMembers: z.number().int().min(0).optional(),
  maxSubCollectives: z.number().int().min(0).optional(),
});

/** Adjust a child collective's resource quota. */
collectivesRouter.put(
  "/api/tenants/:tenantId/collectives/:childId/quota",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const childId = param(req, "childId");
    const userId = authUserId(req);

    const result = await getTenantForUser(tenantId, userId);
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "manage_sub_collectives", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    const parsed = quotaBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
      return;
    }

    const [child] = await db
      .select()
      .from(tenants)
      .where(and(eq(tenants.id, childId), eq(tenants.parentId, tenantId)));

    if (!child) {
      res.status(404).json({ error: "Sub-collective not found" });
      return;
    }

    const { maxDevices, maxMembers, maxSubCollectives } = parsed.data;
    const parent = result.tenant;

    if (maxDevices !== undefined && parent.maxDevices > 0 && maxDevices > parent.maxDevices) {
      res.status(400).json({ error: "Cannot exceed parent's device limit" });
      return;
    }
    if (maxMembers !== undefined && parent.maxMembers > 0 && maxMembers > parent.maxMembers) {
      res.status(400).json({ error: "Cannot exceed parent's member limit" });
      return;
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (maxDevices !== undefined) updates.maxDevices = maxDevices;
    if (maxMembers !== undefined) updates.maxMembers = maxMembers;
    if (maxSubCollectives !== undefined) updates.maxSubCollectives = maxSubCollectives;

    await db.update(tenants).set(updates).where(eq(tenants.id, childId));

    logAudit({
      tenantId,
      actorUserId: userId,
      action: "sub_collective_quota_updated",
      targetType: "tenant",
      targetId: childId,
      metadata: { quotaUpdate: parsed.data },
    });

    res.json({ status: "updated", childId, ...parsed.data });
  },
);

/** Check floor policy compliance for all direct children. */
collectivesRouter.get(
  "/api/tenants/:tenantId/compliance",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "manage_sub_collectives", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    const floor = (result.tenant.floorPolicies ?? {}) as Record<string, unknown>;
    if (Object.keys(floor).length === 0) {
      res.json({ floorPolicies: {}, children: [], allCompliant: true });
      return;
    }

    const children = await db
      .select({
        id: tenants.id,
        slug: tenants.slug,
        name: tenants.name,
        requireDeviceApproval: tenants.requireDeviceApproval,
        lockdownMode: tenants.lockdownMode,
        allowJoinRequests: tenants.allowJoinRequests,
        maxBoardPosts: tenants.maxBoardPosts,
      })
      .from(tenants)
      .where(and(eq(tenants.parentId, tenantId), ne(tenants.status, "deleted")));

    const results = children.map((child) => {
      const violations: string[] = [];

      if (floor.requireDeviceApproval === true && !child.requireDeviceApproval) {
        violations.push("requireDeviceApproval must be true");
      }
      if (floor.lockdownMode === true && !child.lockdownMode) {
        violations.push("lockdownMode must be true");
      }
      if (floor.allowJoinRequests === false && child.allowJoinRequests) {
        violations.push("allowJoinRequests must be false");
      }
      if (typeof floor.maxBoardPosts === "number" && child.maxBoardPosts > (floor.maxBoardPosts as number)) {
        violations.push(`maxBoardPosts exceeds floor limit (${floor.maxBoardPosts})`);
      }

      return {
        id: child.id,
        slug: child.slug,
        name: child.name,
        compliant: violations.length === 0,
        violations,
      };
    });

    res.json({
      floorPolicies: floor,
      children: results,
      allCompliant: results.every((r) => r.compliant),
    });
  },
);

async function rebuildDescendantPaths(
  parentId: string,
  parentPath: string,
  parentDepth: number,
): Promise<void> {
  const children = await db
    .select({ id: tenants.id, slug: tenants.slug })
    .from(tenants)
    .where(and(eq(tenants.parentId, parentId), ne(tenants.status, "deleted")));

  for (const child of children) {
    const childPath = `${parentPath}.${child.slug}`;
    const childDepth = parentDepth + 1;
    await db
      .update(tenants)
      .set({ path: childPath, depth: childDepth, updatedAt: new Date() })
      .where(eq(tenants.id, child.id));
    await rebuildDescendantPaths(child.id, childPath, childDepth);
  }
}
