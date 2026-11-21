/**
 * @module routes/acl
 * ACL policy read and update (manage_acl). Coordinator mode translates it to `{default_deny, rules}`
 * and answers 400 when the policy cannot be expressed exactly.
 */

import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants } from "../db/schema.js";
import { getControlClient, getCoordinatorClient, useCoordinator } from "../orchestrator/control-client.js";
import { AclTranslationError } from "../orchestrator/coordinator-acl.js";
import {
  requireAuth,
  param,
  authUserId,
} from "./helpers.js";
import { tenantGuard, tenantCtx } from "./guard.js";
import { logAudit } from "../audit/log.js";
import { stepUpForSession } from "../auth/step-up.js";
import { logger } from "../logger.js";
import { parseBody } from "./validation.js";

/** True when the tenant has a reachable control plane to read/write policy on. */
function instanceAvailable(tenant: {
  apiKey: string;
  port: number;
  coordinatorTenantId: string | null;
}): boolean {
  if (useCoordinator) return Boolean(tenant.coordinatorTenantId);
  return Boolean(tenant.apiKey && tenant.port > 0);
}

export const aclRouter = Router({ caseSensitive: true });

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
  tenantGuard({ permission: "manage_acl" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = tenantCtx(res);

    if (!instanceAvailable(result.tenant)) {
      res.status(503).json({ error: "Tenant instance not available" });
      return;
    }

    try {
      const client = getControlClient(result.tenant);
      // Coordinator stores {default_deny, rules}; render it in the Headscale
      // shape the dashboard understands.
      const policy = useCoordinator
        ? await getCoordinatorClient(result.tenant).getHeadscalePolicy()
        : await client.getPolicy();

      const users = (await client.listUsers?.()) ?? [];
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
  tenantGuard({ permission: "manage_acl" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = tenantCtx(res);

    if (!instanceAvailable(result.tenant)) {
      res.status(503).json({ error: "Tenant instance not available" });
      return;
    }

    const parsed = parseBody(aclPolicySchema, req, res);
    if (!parsed) return;

    try {
      const client = getControlClient(result.tenant);
      if (useCoordinator) {
        // Translate to the coordinator model; constructs it can't express
        // (groups, tags, autoApprovers, user sources) are rejected below.
        await getCoordinatorClient(result.tenant).setHeadscalePolicy(parsed.data);
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
