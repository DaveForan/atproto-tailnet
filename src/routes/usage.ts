/**
 * @module routes/usage
 * Usage metering and admin-set caps. Provides current usage, the tenant's
 * maxDevices/maxMembers caps (0 = unlimited) and historical snapshots.
 * Usage viewing requires membership; caps are set by the originator only.
 */

import { Router } from "express";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants, usageSnapshots } from "../db/schema.js";
import { getControlClient, useCoordinator } from "../orchestrator/control-client.js";
import {
  requireAuth,
  param,
  authUserId,
} from "./helpers.js";
import { tenantGuard, tenantCtx } from "./guard.js";
import { MAX_LIMIT, checkChildLimit, countMembers, isOverLimit } from "./limits.js";
import { logAudit } from "../audit/log.js";
import { logger } from "../logger.js";

export const usageRouter = Router();

usageRouter.get(
  "/api/tenants/:tenantId/usage",
  requireAuth,
  tenantGuard(),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = tenantCtx(res);

    const { tenant } = result;

    let deviceCount = 0;
    let onlineDevices = 0;
    let routeCount = 0;

    if ((tenant.apiKey || useCoordinator) && tenant.status === "running") {
      try {
        const client = getControlClient(tenant);
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

    const memberCount = await countMembers(tenantId);

    const history = await db
      .select()
      .from(usageSnapshots)
      .where(eq(usageSnapshots.tenantId, tenantId))
      .orderBy(desc(usageSnapshots.recordedAt))
      .limit(168);

    res.json({
      current: {
        devices: deviceCount,
        onlineDevices,
        members: memberCount,
        routes: routeCount,
      },
      limits: {
        maxDevices: tenant.maxDevices,
        maxMembers: tenant.maxMembers,
      },
      overLimit: {
        devices: isOverLimit(deviceCount, tenant.maxDevices),
        members: isOverLimit(memberCount, tenant.maxMembers),
      },
      history: history.reverse(),
    });
  },
);

const limitsBody = z
  .object({
    maxDevices: z.number().int().min(0).max(MAX_LIMIT).optional(),
    maxMembers: z.number().int().min(0).max(MAX_LIMIT).optional(),
  })
  .strict();

/** Set the tenant's caps. Originator only, interactive session only (never agent tokens). */
usageRouter.put(
  "/api/tenants/:tenantId/limits",
  requireAuth,
  tenantGuard({ originatorOnly: "Only the originator can change limits", noAgentToken: "Agent tokens cannot change limits" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = tenantCtx(res);

    const parsed = limitsBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid body", details: parsed.error.issues });
      return;
    }

    const { maxDevices, maxMembers } = parsed.data;

    if (result.tenant.parentId) {
      const [parent] = await db
        .select({ maxDevices: tenants.maxDevices, maxMembers: tenants.maxMembers })
        .from(tenants)
        .where(eq(tenants.id, result.tenant.parentId));
      const err =
        (maxDevices !== undefined && checkChildLimit("device", maxDevices, parent?.maxDevices)) ||
        (maxMembers !== undefined && checkChildLimit("member", maxMembers, parent?.maxMembers));
      if (err) {
        res.status(400).json({ error: err });
        return;
      }
    }

    const updates: Partial<typeof tenants.$inferInsert> = { updatedAt: new Date() };
    if (maxDevices !== undefined) updates.maxDevices = maxDevices;
    if (maxMembers !== undefined) updates.maxMembers = maxMembers;

    try {
      const [updated] = await db
        .update(tenants)
        .set(updates)
        .where(eq(tenants.id, tenantId))
        .returning({ maxDevices: tenants.maxDevices, maxMembers: tenants.maxMembers });

      logAudit({
        tenantId,
        actorUserId: authUserId(req),
        action: "limits_updated",
        targetType: "tenant",
        targetId: tenantId,
        metadata: parsed.data,
      });

      res.json({ status: "updated", limits: updated });
    } catch (err) {
      logger.error({ tenantId, err }, "failed to update limits");
      res.status(500).json({ error: "Failed to update limits" });
    }
  },
);
