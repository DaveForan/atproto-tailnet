/**
 * @module routes/derp
 * Custom DERP relay management per tenant. Allows configuring custom relay
 * regions, toggling the embedded DERP server, and disabling public relays.
 * Gated by the "manage_acl" permission (DERP is network infrastructure config).
 */

import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants, type DerpRegion } from "../db/schema.js";
import {
  updateInstanceConfig,
  stopInstance,
  startInstance,
} from "../orchestrator/headscale.js";
import {
  requireAuth,
  param,
  getTenantForUser,
  hasPermission,
  authUserId,
} from "./helpers.js";
import { logAudit } from "./audit.js";
import { logger } from "../logger.js";

export const derpRouter = Router();

export const derpNodeSchema = z.object({
  name: z.string().min(1).max(50),
  hostname: z.string().min(1).max(253),
  stunPort: z.number().int().min(0).max(65535).optional(),
  derpPort: z.number().int().min(0).max(65535).optional(),
});

export const derpRegionSchema = z.object({
  regionId: z.number().int().min(900).max(999),
  regionCode: z.string().min(1).max(10),
  regionName: z.string().min(1).max(100),
  nodes: z.array(derpNodeSchema).min(1).max(10),
});

export const derpConfigBody = z.object({
  regions: z.array(derpRegionSchema).max(20).optional(),
  embeddedDerpEnabled: z.boolean().optional(),
  usePublicDerp: z.boolean().optional(),
});

derpRouter.get(
  "/api/tenants/:tenantId/derp",
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

    res.json({
      regions: result.tenant.customDerpRegions ?? [],
      embeddedDerpEnabled: result.tenant.embeddedDerpEnabled,
      usePublicDerp: result.tenant.usePublicDerp,
    });
  },
);

derpRouter.put(
  "/api/tenants/:tenantId/derp",
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

    const parsed = derpConfigBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid body", details: parsed.error.issues });
      return;
    }

    const { tenant } = result;
    const regions: DerpRegion[] =
      parsed.data.regions ?? (tenant.customDerpRegions as DerpRegion[]) ?? [];
    const embeddedDerpEnabled =
      parsed.data.embeddedDerpEnabled ?? tenant.embeddedDerpEnabled;
    const usePublicDerp =
      parsed.data.usePublicDerp ?? tenant.usePublicDerp;

    const embeddedChanged = embeddedDerpEnabled !== tenant.embeddedDerpEnabled;

    try {
      await updateInstanceConfig(
        tenant.slug,
        tenant.port,
        {
          derp: {
            embeddedDerpEnabled,
            usePublicDerp,
            hasCustomRegions: regions.length > 0,
          },
          ipv4Prefix: tenant.ipv4Prefix,
          ipv6Prefix: tenant.ipv6Prefix,
          ipAllocation: tenant.ipAllocation,
        },
        regions,
      );

      await db
        .update(tenants)
        .set({
          customDerpRegions: regions,
          embeddedDerpEnabled,
          usePublicDerp,
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, tenantId));

      if (embeddedChanged && tenant.containerId && tenant.status === "running") {
        await stopInstance(tenant.containerId);
        await startInstance(tenant.containerId);
      }

      logAudit({
        tenantId,
        actorUserId: authUserId(req),
        action: "derp_updated",
        targetType: "tenant",
        targetId: tenantId,
        metadata: {
          regionCount: regions.length,
          embeddedDerpEnabled,
          usePublicDerp,
          containerRestarted: embeddedChanged,
        },
      });

      res.json({
        status: "updated",
        regions,
        embeddedDerpEnabled,
        usePublicDerp,
        containerRestarted: embeddedChanged,
      });
    } catch (err) {
      logger.error({ tenantId, err }, "failed to update DERP config");
      res.status(500).json({ error: "Failed to update DERP configuration" });
    }
  },
);
