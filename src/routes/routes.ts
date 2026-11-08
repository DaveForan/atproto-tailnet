/**
 * @module routes/routes
 * Exit node and subnet router management. Lists advertised routes from
 * Headscale and allows approving them or withdrawing approval. Route ids are
 * synthesized per node + prefix (`routeId()` in orchestrator/headscale-api);
 * DELETE withdraws approval, since Headscale no longer deletes routes.
 * Gated by the "manage_devices" permission.
 */

import { Router } from "express";
import { parseRouteId } from "../orchestrator/headscale-api.js";
import { getControlClient, useCoordinator } from "../orchestrator/control-client.js";
import {
  requireAuth,
  param,
  getTenantForUser,
  hasPermission,
  authUserId,
} from "./helpers.js";
import { logAudit } from "./audit.js";
import { logger } from "../logger.js";

export const routesRouter = Router();

routesRouter.get(
  "/api/tenants/:tenantId/routes",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "manage_devices", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

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
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const routeId = param(req, "routeId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "manage_devices", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    if (useCoordinator) {
      res.status(501).json({ error: "Per-route approval is not applicable in coordinator mode — routes are derived from tenant CIDR prefixes" });
      return;
    }

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
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const routeId = param(req, "routeId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "manage_devices", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    if (useCoordinator) {
      res.status(501).json({ error: "Per-route approval is not applicable in coordinator mode — routes are derived from tenant CIDR prefixes" });
      return;
    }

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
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const routeId = param(req, "routeId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "manage_devices", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    if (useCoordinator) {
      res.status(501).json({ error: "Per-route approval is not applicable in coordinator mode — routes are derived from tenant CIDR prefixes" });
      return;
    }

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
