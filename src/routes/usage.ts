/**
 * @module routes/usage
 * Usage metering and plan management. Provides current usage stats,
 * historical usage snapshots, and plan limit configuration.
 * Usage viewing requires membership; plan changes require manage_settings.
 */

import { Router } from "express";
import { z } from "zod";
import { eq, desc, sql, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants, memberships, usageSnapshots } from "../db/schema.js";
import { HeadscaleApiClient } from "../orchestrator/headscale-api.js";
import {
  requireAuth,
  param,
  getTenantForUser,
  hasPermission,
  authUserId,
} from "./helpers.js";
import { logAudit } from "./audit.js";
import { logger } from "../logger.js";

export const usageRouter = Router();

usageRouter.get(
  "/api/tenants/:tenantId/usage",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const { tenant } = result;

    let deviceCount = 0;
    let onlineDevices = 0;
    let routeCount = 0;

    if (tenant.apiKey && tenant.port && tenant.status === "running") {
      try {
        const client = new HeadscaleApiClient(tenant.port, tenant.apiKey);
        const [nodes, routes] = await Promise.all([
          client.listNodes(),
          client.listRoutes().catch(() => []),
        ]);
        deviceCount = nodes.length;
        onlineDevices = nodes.filter((n) => n.online).length;
        routeCount = routes.length;
      } catch {
        // instance may be down
      }
    }

    const memberRows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(memberships)
      .where(eq(memberships.tenantId, tenantId));
    const memberCount = memberRows[0]?.count ?? 0;

    const history = await db
      .select()
      .from(usageSnapshots)
      .where(eq(usageSnapshots.tenantId, tenantId))
      .orderBy(desc(usageSnapshots.recordedAt))
      .limit(168);

    res.json({
      current: {
        deviceCount,
        onlineDevices,
        memberCount,
        routeCount,
      },
      plan: {
        name: tenant.planName,
        maxDevices: tenant.maxDevices,
        maxMembers: tenant.maxMembers,
      },
      limits: {
        devicesExceeded:
          tenant.maxDevices > 0 && deviceCount > tenant.maxDevices,
        membersExceeded:
          tenant.maxMembers > 0 && memberCount > tenant.maxMembers,
      },
      history: history.reverse(),
    });
  },
);

const planBody = z.object({
  planName: z.enum(["free", "starter", "pro", "enterprise"]).optional(),
  maxDevices: z.number().int().min(0).max(10000).optional(),
  maxMembers: z.number().int().min(0).max(10000).optional(),
});

usageRouter.put(
  "/api/tenants/:tenantId/plan",
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

    const parsed = planBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid body", details: parsed.error.issues });
      return;
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.data.planName !== undefined)
      updates.planName = parsed.data.planName;
    if (parsed.data.maxDevices !== undefined)
      updates.maxDevices = parsed.data.maxDevices;
    if (parsed.data.maxMembers !== undefined)
      updates.maxMembers = parsed.data.maxMembers;

    try {
      await db
        .update(tenants)
        .set(updates)
        .where(eq(tenants.id, tenantId));

      logAudit({
        tenantId,
        actorUserId: authUserId(req),
        action: "plan_updated",
        targetType: "tenant",
        targetId: tenantId,
        metadata: parsed.data,
      });

      res.json({ status: "updated", ...parsed.data });
    } catch (err) {
      logger.error({ tenantId, err }, "failed to update plan");
      res.status(500).json({ error: "Failed to update plan" });
    }
  },
);
