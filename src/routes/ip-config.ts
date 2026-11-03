/**
 * @module routes/ip-config
 * Per-tenant IP range configuration. Allows customizing IPv4/IPv6 prefixes
 * and allocation strategy. Changes require a container restart and will
 * cause existing devices to lose their assigned IPs.
 * Gated by the "manage_settings" permission.
 */

import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants } from "../db/schema.js";
import type { DerpRegion } from "../db/schema.js";
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

export const ipConfigRouter = Router();

export const CIDR_V4_RE = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
export const CIDR_V6_RE = /^[0-9a-fA-F:]+\/\d{1,3}$/;

export const ipConfigBody = z.object({
  ipv4Prefix: z
    .string()
    .regex(CIDR_V4_RE, "Must be a valid IPv4 CIDR (e.g. 100.64.0.0/10)")
    .optional(),
  ipv6Prefix: z
    .string()
    .regex(CIDR_V6_RE, "Must be a valid IPv6 CIDR (e.g. fd7a:115c:a1e0::/48)")
    .optional(),
  ipAllocation: z.enum(["sequential", "random"]).optional(),
});

ipConfigRouter.get(
  "/api/tenants/:tenantId/ip-config",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (
      !hasPermission(result.membership, result.role, "manage_settings", req)
    ) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    res.json({
      ipv4Prefix: result.tenant.ipv4Prefix,
      ipv6Prefix: result.tenant.ipv6Prefix,
      ipAllocation: result.tenant.ipAllocation,
    });
  },
);

ipConfigRouter.put(
  "/api/tenants/:tenantId/ip-config",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (
      !hasPermission(result.membership, result.role, "manage_settings", req)
    ) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    const parsed = ipConfigBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid body", details: parsed.error.issues });
      return;
    }

    const { tenant } = result;
    const ipv4Prefix = parsed.data.ipv4Prefix ?? tenant.ipv4Prefix;
    const ipv6Prefix = parsed.data.ipv6Prefix ?? tenant.ipv6Prefix;
    const ipAllocation = parsed.data.ipAllocation ?? tenant.ipAllocation;

    const changed =
      ipv4Prefix !== tenant.ipv4Prefix ||
      ipv6Prefix !== tenant.ipv6Prefix ||
      ipAllocation !== tenant.ipAllocation;

    if (!changed) {
      res.json({
        status: "unchanged",
        ipv4Prefix,
        ipv6Prefix,
        ipAllocation,
      });
      return;
    }

    try {
      const regions = (tenant.customDerpRegions ?? []) as DerpRegion[];
      await updateInstanceConfig(
        tenant.slug,
        tenant.port,
        {
          derp: {
            embeddedDerpEnabled: tenant.embeddedDerpEnabled,
            usePublicDerp: tenant.usePublicDerp,
            hasCustomRegions: regions.length > 0,
          },
          ipv4Prefix,
          ipv6Prefix,
          ipAllocation,
        },
        regions,
      );

      await db
        .update(tenants)
        .set({
          ipv4Prefix,
          ipv6Prefix,
          ipAllocation,
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, tenantId));

      if (tenant.containerId && tenant.status === "running") {
        await stopInstance(tenant.containerId);
        await startInstance(tenant.containerId);
      }

      logAudit({
        tenantId,
        actorUserId: authUserId(req),
        action: "ip_config_updated",
        targetType: "tenant",
        targetId: tenantId,
        metadata: {
          ipv4Prefix,
          ipv6Prefix,
          ipAllocation,
          previousV4: tenant.ipv4Prefix,
          previousV6: tenant.ipv6Prefix,
        },
      });

      res.json({
        status: "updated",
        ipv4Prefix,
        ipv6Prefix,
        ipAllocation,
        containerRestarted: !!(tenant.containerId && tenant.status === "running"),
      });
    } catch (err) {
      logger.error({ tenantId, err }, "failed to update IP config");
      res.status(500).json({ error: "Failed to update IP configuration" });
    }
  },
);
