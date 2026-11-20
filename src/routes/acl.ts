/**
 * @module routes/acl
 * ACL policy management: read the current Headscale policy and push updates.
 * Gated by the "manage_acl" permission. Policies are pushed directly to the
 * Headscale instance via its REST API (policy mode: database). In
 * coordinator mode the policy is translated to the coordinator's
 * `{default_deny, rules}` model (see orchestrator/coordinator-acl.ts) and
 * rejected with 400 if it can't be expressed faithfully.
 */

import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants } from "../db/schema.js";
import { getControlClient, useCoordinator } from "../orchestrator/control-client.js";
import { CoordinatorApiClient } from "../orchestrator/coordinator-api.js";
import { AclTranslationError } from "../orchestrator/coordinator-acl.js";
import {
  requireAuth,
  param,
  getTenantForUser,
  hasPermission,
  authUserId,
} from "./helpers.js";
import { logAudit } from "./audit.js";
import { stepUpForSession } from "../auth/step-up.js";
import { logger } from "../logger.js";

/** True when the tenant has a reachable control plane to read/write policy on. */
function instanceAvailable(tenant: {
  apiKey: string;
  port: number;
  coordinatorTenantId: string | null;
}): boolean {
  if (useCoordinator) return Boolean(tenant.coordinatorTenantId);
  return Boolean(tenant.apiKey && tenant.port > 0);
}

/** Router for ACL policy CRUD: get and update. */
export const aclRouter = Router();

const aclRuleSchema = z.object({
  action: z.enum(["accept"]),
  src: z.array(z.string().min(1)).min(1),
  dst: z.array(z.string().min(1)).min(1),
});

const aclGroupSchema = z.record(
  z.string().regex(/^group:/),
  z.array(z.string()),
);

const aclPolicySchema = z.object({
  acls: z.array(aclRuleSchema).default([]),
  groups: aclGroupSchema.optional().default({}),
  hosts: z.record(z.string(), z.string()).optional().default({}),
  tagOwners: z.record(z.string(), z.array(z.string())).optional().default({}),
  autoApprovers: z
    .object({
      routes: z.record(z.string(), z.array(z.string())).optional(),
      exitNode: z.record(z.string(), z.array(z.string())).optional(),
    })
    .optional()
    .default({}),
});

aclRouter.get(
  "/api/tenants/:tenantId/acl",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "manage_acl", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    if (!instanceAvailable(result.tenant)) {
      res.status(503).json({ error: "Tenant instance not available" });
      return;
    }

    try {
      const client = getControlClient(result.tenant);
      // Coordinator stores {default_deny, rules}; render it in the Headscale
      // shape the dashboard understands.
      const policy =
        client instanceof CoordinatorApiClient
          ? await client.getHeadscalePolicy()
          : await client.getPolicy();

      const users = await client.listUsers();
      const userNames = users.map((u) => u.name);

      res.json({ policy, users: userNames });
    } catch (err) {
      logger.error({ tenantId, err }, "failed to fetch ACL policy");
      res.status(502).json({ error: "Failed to fetch policy from Headscale" });
    }
  },
);

aclRouter.put(
  "/api/tenants/:tenantId/acl",
  requireAuth,
  stepUpForSession,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "manage_acl", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    if (!instanceAvailable(result.tenant)) {
      res.status(503).json({ error: "Tenant instance not available" });
      return;
    }

    const parsed = aclPolicySchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid body", details: parsed.error.issues });
      return;
    }

    try {
      const client = getControlClient(result.tenant);
      if (client instanceof CoordinatorApiClient) {
        // Translate to the coordinator model; constructs it can't express
        // (groups, tags, autoApprovers, user sources) are rejected below.
        await client.setHeadscalePolicy(parsed.data);
        await db
          .update(tenants)
          .set({ coordinatorAclPolicy: parsed.data, updatedAt: new Date() })
          .where(eq(tenants.id, tenantId));
      } else {
        await client.setPolicy(parsed.data);
      }

      logAudit({
        tenantId,
        actorUserId: authUserId(req),
        action: "acl_updated",
        targetType: "tenant",
        targetId: tenantId,
        metadata: {
          ruleCount: parsed.data.acls.length,
          groupCount: Object.keys(parsed.data.groups).length,
        },
      });

      res.json({ status: "updated", policy: parsed.data });
    } catch (err) {
      if (err instanceof AclTranslationError) {
        res.status(400).json({ error: err.message });
        return;
      }
      logger.error({ tenantId, err }, "failed to update ACL policy");
      res.status(502).json({ error: "Failed to push policy to Headscale" });
    }
  },
);
