/**
 * @module routes/acl
 * ACL policy read and update (manage_acl). The service translates it to `{default_deny, rules}`
 * and answers 400 when the policy cannot be expressed exactly.
 */

import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants } from "../db/schema.js";
import { getCoordinatorClient } from "../orchestrator/control-client.js";
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

    if (!result.tenant.coordinatorTenantId) {
      res.status(503).json({ error: "Tenant instance not available" });
      return;
    }

    try {
      // The coordinator stores {default_deny, rules}. The dashboard edits the Tailscale ACL policy file format.
      res.json({ policy: await getCoordinatorClient(result.tenant).getAclPolicyFile() });
    } catch (err) {
      logger.error({ tenantId, err }, "failed to fetch ACL policy");
      res.status(502).json({ error: "Failed to fetch the policy" });
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

    if (!result.tenant.coordinatorTenantId) {
      res.status(503).json({ error: "Tenant instance not available" });
      return;
    }

    const parsed = parseBody(aclPolicySchema, req, res);
    if (!parsed) return;

    try {
      // Constructs that the coordinator model cannot express (groups, tags, autoApprovers, user sources) are refused below.
      await getCoordinatorClient(result.tenant).setAclPolicyFile(parsed.data);
      await db
        .update(tenants)
        .set({ coordinatorAclPolicy: parsed.data, updatedAt: new Date() })
        .where(eq(tenants.id, tenantId));

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
      res.status(502).json({ error: "Failed to save the policy" });
    }
  },
);
