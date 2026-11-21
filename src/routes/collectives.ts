/**
 * @module routes/collectives
 * Hierarchical tenancy — create, list, detach, and eject sub-collectives.
 * Gated by "manage_sub_collectives" permission.
 */

import { Router } from "express";
import { z } from "zod";
import { eq, and, ne, sql, like } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants } from "../db/schema.js";
import {
  requireAuth,
  param,
  authUserId,
  authUserDid,
} from "./helpers.js";
import { tenantGuard, tenantCtx } from "./guard.js";
import { logAudit } from "../audit/log.js";
import { logger } from "../logger.js";
import { useCoordinator } from "../orchestrator/control-client.js";
import { createTenantRecord, provisionTenantInstance } from "../orchestrator/tenant-provisioning.js";
import { rebuildDescendantPaths } from "../orchestrator/tenant-hierarchy.js";
import { hostnameAvailableFor, validateHostname } from "../orchestrator/hostnames.js";
import { MAX_LIMIT, checkChildLimit } from "./limits.js";
import {
  canCreateTailnet,
  getInstanceSettings,
  isOperatorDid,
  listTopLevelTenants,
} from "../operator/policy.js";
import { parseBody } from "./validation.js";

export const collectivesRouter = Router();

/**
 * Sub-collectives are provisioned like top-level tenants, so the slug must be
 * a DNS label (it becomes `<slug>.<BASE_DOMAIN>`, a container name and the
 * coordinator slug, which requires ^[a-z0-9][a-z0-9-]{0,62}$). No dots: the
 * materialized path uses "." as separator.
 */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const MAX_DEPTH = 5;

export const createSubCollectiveBody = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(2).max(40).regex(SLUG_RE, "Slug must be lowercase letters, digits and inner hyphens only"),
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
  tenantGuard(),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = tenantCtx(res);

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
  tenantGuard(),
  async (req, res) => {
    const result = tenantCtx(res);

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
  tenantGuard({ permission: "manage_sub_collectives" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const userId = authUserId(req);
    const result = tenantCtx(res);

    const parsed = parseBody(createSubCollectiveBody, req, res);
    if (!parsed) return;

    const { tenant } = result;

    if (tenant.suspended) {
      res.status(409).json({ error: "This tailnet is suspended", code: "tenant_suspended" });
      return;
    }

    // Single-tailnet mode: the instance holds exactly one tailnet, no children
    if ((await getInstanceSettings()).singleTailnet) {
      res.status(409).json({
        error: "This instance is in single-tailnet mode — sub-collectives cannot be created",
        code: "single_tailnet",
        tenants: await listTopLevelTenants(),
      });
      return;
    }

    // A sub-collective is a tailnet: only operators and designated tailnet
    // creators may make one (agent tokens never carry instance powers).
    const did = req.agentToken ? null : await authUserDid(req);
    if (!did || !(isOperatorDid(did) || (await canCreateTailnet({ did })))) {
      res.status(403).json({
        error: "Only instance operators and designated tailnet creators can create sub-collectives",
        code: "cannot_create_tailnet",
      });
      return;
    }

    if (tenant.depth >= MAX_DEPTH) {
      res.status(400).json({ error: `Maximum nesting depth (${MAX_DEPTH}) reached` });
      return;
    }

    if (useCoordinator && !tenant.coordinatorTenantId) {
      res.status(409).json({ error: "Parent collective is not provisioned yet" });
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
    // The slug is also the sub-tailnet's first public address
    const checked = validateHostname(slug);
    if (!checked.ok) {
      res.status(400).json({ error: checked.error === "reserved" ? "That address is reserved" : "Invalid address" });
      return;
    }
    if (!(await hostnameAvailableFor(slug, ""))) {
      res.status(409).json({ error: "Slug already in use" });
      return;
    }

    try {
      const child = await createTenantRecord({ ownerUserId: userId, name, parent: tenant, slug, hostname: slug });
      // The dashboard polls until the status leaves "provisioning"
      setImmediate(() => {
        void provisionTenantInstance(child.id, child.slug, child.port, {
          parentCoordinatorTenantId: tenant.coordinatorTenantId,
        });
      });

      logAudit({
        tenantId,
        actorUserId: userId,
        action: "sub_collective_created",
        targetType: "tenant",
        targetId: child.id,
        metadata: { childSlug: slug, childName: name, depth: child.depth },
      });

      res.status(201).json({
        id: child.id,
        slug: child.slug,
        name: child.name,
        parentId: tenantId,
        path: child.path,
        depth: child.depth,
        status: child.status,
      });
    } catch (err) {
      logger.error({ tenantId, slug, err }, "failed to create sub-collective");
      res.status(500).json({ error: "Failed to create sub-collective" });
    }
  },
);

/**
 * Escapes LIKE metacharacters (`\`, `%`, `_`) so a value matches literally.
 * Postgres' default LIKE escape character is backslash.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Detach a sub-collective (child declares independence). */
collectivesRouter.post(
  "/api/tenants/:tenantId/detach",
  requireAuth,
  // Hierarchy-changing action: interactive session only, never agent tokens
  tenantGuard({
    originatorOnly: "Only the originator can detach a collective",
    noAgentToken: "Agent tokens cannot detach a collective",
  }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const userId = authUserId(req);
    const result = tenantCtx(res);

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
  tenantGuard({ permission: "manage_sub_collectives" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const childId = param(req, "childId");
    const userId = authUserId(req);

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
  tenantGuard({ permission: "manage_sub_collectives" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const userId = authUserId(req);

    const parsed = parseBody(floorPolicyBody, req, res);
    if (!parsed) return;

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
  tenantGuard(),
  async (req, res) => {
    const result = tenantCtx(res);

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
          like(tenants.path, `${escapeLike(pathPrefix)}%`),
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
  maxDevices: z.number().int().min(0).max(MAX_LIMIT).optional(),
  maxMembers: z.number().int().min(0).max(MAX_LIMIT).optional(),
  maxSubCollectives: z.number().int().min(0).max(1000).optional(),
});

/** Adjust a child collective's resource quota. */
collectivesRouter.put(
  "/api/tenants/:tenantId/collectives/:childId/quota",
  requireAuth,
  tenantGuard({ permission: "manage_sub_collectives" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const childId = param(req, "childId");
    const userId = authUserId(req);
    const result = tenantCtx(res);

    const parsed = parseBody(quotaBody, req, res);
    if (!parsed) return;

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

    // 0 = unlimited: allowed only under an unlimited parent
    const limitErr =
      (maxDevices !== undefined && checkChildLimit("device", maxDevices, parent.maxDevices)) ||
      (maxMembers !== undefined && checkChildLimit("member", maxMembers, parent.maxMembers));
    if (limitErr) {
      res.status(400).json({ error: limitErr });
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
  tenantGuard({ permission: "manage_sub_collectives" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = tenantCtx(res);

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
