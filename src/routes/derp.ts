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
import { useCoordinator } from "../orchestrator/control-client.js";
import { CoordinatorApiClient } from "../orchestrator/coordinator-api.js";
import { config } from "../config.js";

export const derpRouter = Router();

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
      embeddedDerpEnabled: useCoordinator ? false : result.tenant.embeddedDerpEnabled,
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

    if (useCoordinator && config.coordinatorUrl) {
      const parsed = derpConfigBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
        return;
      }
      const { tenant } = result;
      if (!tenant.coordinatorTenantId) {
        res.status(409).json({ error: "Tenant is not registered with the coordinator yet" });
        return;
      }
      const regions: DerpRegion[] =
        parsed.data.regions ?? (tenant.customDerpRegions as DerpRegion[]) ?? [];
      const usePublicDerp = parsed.data.usePublicDerp ?? tenant.usePublicDerp;
      if (regions.length === 0 && !usePublicDerp) {
        res.status(400).json({ error: "Enable public relays or add at least one custom region" });
        return;
      }
      try {
        const client = new CoordinatorApiClient(
          config.coordinatorUrl,
          tenant.coordinatorTenantId,
          config.coordinatorApiKey,
        );
        await client.setDerp(regions, usePublicDerp);
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
          metadata: { coordinator: true, regionCount: regions.length, usePublicDerp },
        });
        res.json({ status: "updated", regions, embeddedDerpEnabled: false, usePublicDerp });
      } catch (err) {
        logger.error({ tenantId, err }, "failed to update coordinator DERP config");
        res.status(502).json({ error: "Failed to update DERP configuration on coordinator" });
      }
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
