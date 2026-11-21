/**
 * @module routes/routes
 * Exit nodes and subnet routes (manage_devices): list, approve, withdraw. Route ids are node + prefix (`routeId()`).
 */

import { Router } from "express";
import { parseRouteId } from "../orchestrator/headscale-api.js";
import { getControlClient } from "../orchestrator/control-client.js";
import {
  requireAuth,
  param,
  authUserId,
} from "./helpers.js";
import { tenantGuard, tenantCtx } from "./guard.js";
import { logAudit } from "../audit/log.js";
import { logger } from "../logger.js";

export const routesRouter = Router({ caseSensitive: true });

routesRouter.get(
  "/api/tenants/:tenantId/routes",
  requireAuth,
  tenantGuard({ permission: "manage_devices" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = tenantCtx(res);

    if (!result.tenant.apiKey || !result.tenant.port) {
      res.status(503).json({ error: "Tenant instance not available" });
      return;
    }

    try {
      const client = getControlClient(result.tenant);
      const routes = await client.listRoutes();

      const exitNodes = routes.filter(
        (r) => r.prefix === "0.0.0.0/0" || r.prefix === "::/0",
      );
      const subnets = routes.filter(
        (r) => r.prefix !== "0.0.0.0/0" && r.prefix !== "::/0",
      );

      res.json({ exitNodes, subnets });
    } catch (err) {
      logger.error({ tenantId, err }, "failed to list routes");
      res.status(502).json({ error: "Failed to fetch routes from Headscale" });
    }
  },
);

routesRouter.post(
  "/api/tenants/:tenantId/routes/:routeId/enable",
  requireAuth,
  tenantGuard({ permission: "manage_devices" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const routeId = param(req, "routeId");
    const result = tenantCtx(res);

    if (!result.tenant.apiKey || !result.tenant.port) {
      res.status(503).json({ error: "Tenant instance not available" });
      return;
    }

    if (!parseRouteId(routeId)) {
      res.status(404).json({ error: "Route not found" });
      return;
    }

    try {
      const client = getControlClient(result.tenant);
      await client.enableRoute(routeId);

      logAudit({
        tenantId,
        actorUserId: authUserId(req),
        action: "route_enabled",
        targetType: "route",
        targetId: routeId,
      });

      res.json({ status: "enabled" });
    } catch (err) {
      logger.error({ tenantId, routeId, err }, "failed to enable route");
      res.status(502).json({ error: "Failed to enable route" });
    }
  },
);

routesRouter.post(
  "/api/tenants/:tenantId/routes/:routeId/disable",
  requireAuth,
  tenantGuard({ permission: "manage_devices" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const routeId = param(req, "routeId");
    const result = tenantCtx(res);

    if (!result.tenant.apiKey || !result.tenant.port) {
      res.status(503).json({ error: "Tenant instance not available" });
      return;
    }

    if (!parseRouteId(routeId)) {
      res.status(404).json({ error: "Route not found" });
      return;
    }

    try {
      const client = getControlClient(result.tenant);
      await client.disableRoute(routeId);

      logAudit({
        tenantId,
        actorUserId: authUserId(req),
        action: "route_disabled",
        targetType: "route",
        targetId: routeId,
      });

      res.json({ status: "disabled" });
    } catch (err) {
      logger.error({ tenantId, routeId, err }, "failed to disable route");
      res.status(502).json({ error: "Failed to disable route" });
    }
  },
);

routesRouter.delete(
  "/api/tenants/:tenantId/routes/:routeId",
  requireAuth,
  tenantGuard({ permission: "manage_devices" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const routeId = param(req, "routeId");
    const result = tenantCtx(res);

    if (!result.tenant.apiKey || !result.tenant.port) {
      res.status(503).json({ error: "Tenant instance not available" });
      return;
    }

    if (!parseRouteId(routeId)) {
      res.status(404).json({ error: "Route not found" });
      return;
    }

    try {
      const client = getControlClient(result.tenant);
      await client.deleteRoute(routeId);

      logAudit({
        tenantId,
        actorUserId: authUserId(req),
        action: "route_deleted",
        targetType: "route",
        targetId: routeId,
      });

      res.json({ status: "deleted" });
    } catch (err) {
      logger.error({ tenantId, routeId, err }, "failed to delete route");
      res.status(502).json({ error: "Failed to delete route" });
    }
  },
);
