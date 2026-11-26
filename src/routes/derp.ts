/**
 * @module routes/derp
 * Per-tenant DERP relays: custom regions and the switch for the instance's default relays (manage_acl; writes need step-up).
 */

import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants, type DerpRegion } from "../db/schema.js";
import {
  requireAuth,
  param,
  authUserId,
} from "./helpers.js";
import { tenantGuard, tenantCtx } from "./guard.js";
import { logAudit } from "../audit/log.js";
import { logger } from "../logger.js";
import { getCoordinatorClient } from "../orchestrator/control-client.js";
import { parseBody } from "./validation.js";
import { stepUpForSession } from "../auth/step-up.js";

export const derpRouter = Router({ caseSensitive: true });

const DERP_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const DERP_HOSTNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

export const derpNodeSchema = z.object({
  name: z.string().min(1).max(50).regex(DERP_LABEL_RE),
  hostname: z.string().min(1).max(253).regex(DERP_HOSTNAME_RE),
  stunPort: z.number().int().min(0).max(65535).optional(),
  derpPort: z.number().int().min(0).max(65535).optional(),
});

export const derpRegionSchema = z.object({
  regionId: z.number().int().min(900).max(999),
  regionCode: z.string().min(1).max(10).regex(DERP_LABEL_RE),
  regionName: z.string().min(1).max(100).regex(/^[A-Za-z0-9 _.()-]+$/),
  nodes: z.array(derpNodeSchema).min(1).max(10),
});

export const derpConfigBody = z.object({
  regions: z.array(derpRegionSchema).max(20).optional(),
  usePublicDerp: z.boolean().optional(),
});

derpRouter.get(
  "/api/tenants/:tenantId/derp",
  requireAuth,
  tenantGuard({ permission: "manage_acl" }),
  async (req, res) => {
    const result = tenantCtx(res);

    res.json({
      regions: result.tenant.customDerpRegions ?? [],
      usePublicDerp: result.tenant.usePublicDerp,
    });
  },
);

derpRouter.put(
  "/api/tenants/:tenantId/derp",
  requireAuth,
  stepUpForSession,
  tenantGuard({ permission: "manage_acl" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = tenantCtx(res);

    const parsed = parseBody(derpConfigBody, req, res);
    if (!parsed) return;
    const { tenant } = result;
    if (!tenant.coordinatorTenantId) {
      res.status(409).json({ error: "Tenant is not registered with the coordinator yet" });
      return;
    }
    const regions: DerpRegion[] = parsed.data.regions ?? (tenant.customDerpRegions as DerpRegion[]) ?? [];
    const usePublicDerp = parsed.data.usePublicDerp ?? tenant.usePublicDerp;
    if (regions.length === 0 && !usePublicDerp) {
      res.status(400).json({ error: "Enable public relays or add at least one custom region" });
      return;
    }
    try {
      await getCoordinatorClient(tenant).setDerp(regions, usePublicDerp);
      await db
        .update(tenants)
        .set({ customDerpRegions: regions, usePublicDerp, updatedAt: new Date() })
        .where(eq(tenants.id, tenantId));
      logAudit({
        tenantId,
        actorUserId: authUserId(req),
        action: "derp_updated",
        targetType: "tenant",
        targetId: tenantId,
        metadata: { regionCount: regions.length, usePublicDerp },
      });
      res.json({ status: "updated", regions, usePublicDerp });
    } catch (err) {
      logger.error({ tenantId, err }, "failed to update DERP config");
      res.status(502).json({ error: "Failed to update the DERP configuration" });
    }
  },
);
