/**
 * @module routes/traversal
 * Traversal policy CRUD and evaluation endpoints (ADR-0011).
 * Policies control cross-collective traffic at egress and ingress boundaries.
 */

import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants } from "../db/schema.js";
import {
  requireAuth,
  param,
  getTenantForUser,
  hasPermission,
  authUserId,
  isLockedDown,
} from "./helpers.js";
import { logAudit } from "./audit.js";
import { logger } from "../logger.js";
import { parsePolicy } from "../policy-engine/parser.js";
import { evaluateTraversal } from "../policy-engine/evaluator.js";
import type { CompiledPolicy, TraversalRequest } from "../policy-engine/types.js";

export const traversalRouter = Router();

traversalRouter.get(
  "/api/tenants/:tenantId/traversal-policy",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "manage_settings", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    const rows = await db
      .select({
        egressPolicy: tenants.egressPolicy,
        ingressPolicy: tenants.ingressPolicy,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const tenant = rows[0];
    res.json({
      egress: tenant?.egressPolicy ?? null,
      ingress: tenant?.ingressPolicy ?? null,
    });
  },
);

traversalRouter.put(
  "/api/tenants/:tenantId/traversal-policy",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "manage_settings", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    if (isLockedDown(result.tenant)) {
      res.status(403).json({ error: "Tenant is in lockdown mode" });
      return;
    }

    const { egress, ingress } = req.body ?? {};
    const errors: string[] = [];

    let egressParsed = null;
    let ingressParsed = null;

    if (egress !== undefined && egress !== null) {
      const parsed = parsePolicy(egress);
      if (parsed.errors.length > 0) {
        errors.push(...parsed.errors.map((e) => `egress: ${e}`));
      } else {
        egressParsed = parsed.policy;
      }
    }

    if (ingress !== undefined && ingress !== null) {
      const parsed = parsePolicy(ingress);
      if (parsed.errors.length > 0) {
        errors.push(...parsed.errors.map((e) => `ingress: ${e}`));
      } else {
        ingressParsed = parsed.policy;
      }
    }

    if (errors.length > 0) {
      res.status(400).json({ error: "Invalid policy", details: errors });
      return;
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (egress !== undefined) updates.egressPolicy = egressParsed;
    if (ingress !== undefined) updates.ingressPolicy = ingressParsed;

    await db.update(tenants).set(updates).where(eq(tenants.id, tenantId));

    logAudit({
      tenantId,
      actorUserId: authUserId(req),
      action: "tenant_settings_updated",
      targetType: "tenant",
      targetId: tenantId,
      metadata: {
        operation: "traversal_policy_update",
        updatedDirections: Object.keys(req.body).filter((k) => k === "egress" || k === "ingress"),
      },
    });

    res.json({
      egress: egress !== undefined ? egressParsed : undefined,
      ingress: ingress !== undefined ? ingressParsed : undefined,
      saved: true,
    });
  },
);

traversalRouter.post(
  "/api/tenants/:tenantId/traversal-policy/evaluate",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "manage_settings", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    const { identity, sourceCollective, destinationCollective, requestedResources } = req.body ?? {};
    if (
      typeof identity !== "string" || !identity ||
      typeof sourceCollective !== "string" || !sourceCollective ||
      typeof destinationCollective !== "string" || !destinationCollective
    ) {
      res.status(400).json({
        error: "Missing required string fields: identity, sourceCollective, destinationCollective",
      });
      return;
    }
    if (requestedResources !== undefined && !Array.isArray(requestedResources)) {
      res.status(400).json({ error: "requestedResources must be an array of strings" });
      return;
    }

    const rows = await db
      .select({
        egressPolicy: tenants.egressPolicy,
        ingressPolicy: tenants.ingressPolicy,
        path: tenants.path,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const tenant = rows[0];
    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const request: TraversalRequest = {
      identity,
      sourceCollective,
      destinationCollective,
      requestedResources: requestedResources ?? [],
      timestamp: new Date(),
    };

    let egressCompiled: CompiledPolicy | null = null;
    let ingressCompiled: CompiledPolicy | null = null;

    if (tenant.egressPolicy) {
      const parsed = parsePolicy(tenant.egressPolicy);
      if (parsed.policy) {
        egressCompiled = {
          collectiveId: tenantId,
          direction: "egress",
          policy: parsed.policy,
          compiledAt: new Date(),
          floors: await getFloorRules(tenantId, "egress"),
          ceilings: [],
        };
      }
    }

    if (tenant.ingressPolicy) {
      const parsed = parsePolicy(tenant.ingressPolicy);
      if (parsed.policy) {
        ingressCompiled = {
          collectiveId: tenantId,
          direction: "ingress",
          policy: parsed.policy,
          compiledAt: new Date(),
          floors: await getFloorRules(tenantId, "ingress"),
          ceilings: [],
        };
      }
    }

    const stubContext = {
      membershipLookup: async () => [],
      federationLinkCheck: async () => true,
      hierarchyDepth: () => 1,
    };

    try {
      const trace = await evaluateTraversal(
        request,
        egressCompiled,
        ingressCompiled,
        stubContext,
      );
      res.json({ trace });
    } catch (err) {
      logger.error({ tenantId, err }, "traversal evaluation failed");
      res.status(500).json({ error: "Evaluation failed" });
    }
  },
);

async function getFloorRules(
  tenantId: string,
  _direction: "egress" | "ingress",
): Promise<import("../policy-engine/types.js").PolicyRule[]> {
  const rows = await db
    .select({ parentId: tenants.parentId })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  if (!rows[0]?.parentId) return [];

  const parentRows = await db
    .select({
      egressPolicy: tenants.egressPolicy,
      ingressPolicy: tenants.ingressPolicy,
      floorPolicies: tenants.floorPolicies,
    })
    .from(tenants)
    .where(eq(tenants.id, rows[0].parentId))
    .limit(1);

  const parent = parentRows[0];
  if (!parent) return [];

  const fp = parent.floorPolicies as Record<string, unknown> | null;
  if (!fp?.traversalFloors) return [];

  const floors = fp.traversalFloors as Record<string, unknown>;
  const dirFloors = floors[_direction] as unknown[] | undefined;
  if (!Array.isArray(dirFloors)) return [];

  return dirFloors as import("../policy-engine/types.js").PolicyRule[];
}
