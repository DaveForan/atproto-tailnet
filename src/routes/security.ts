/**
 * @module routes/security
 * Tenant security routers in mount order: notifications, permissions, settings, roles, device approvals,
 * join requests, device locks, audit log.
 */

import { Router } from "express";
import { requireAuth } from "./helpers.js";
import { ALL_PERMISSIONS } from "../members/permissions.js";
import { notificationsRouter } from "./notifications.js";
import { settingsRouter } from "./settings.js";
import { rolesRouter } from "./roles.js";
import { deviceApprovalsRouter } from "./device-approvals.js";
import { joinRequestsRouter } from "./join-requests.js";
import { deviceLocksRouter } from "./device-locks.js";
import { auditLogRouter } from "./audit-log.js";

/**
 * Router for tenant settings, roles CRUD, role assignment, device approvals/locks,
 * join-request management, and audit log retrieval.
 */
export const securityRouter = Router({ caseSensitive: true });

// Notifications live in their own module; mounted here so index.ts is unchanged.
securityRouter.use(notificationsRouter);

// ── Permissions list ────────────────────────────────────────────────

securityRouter.get("/api/permissions", requireAuth, (_req, res) => {
  res.json(ALL_PERMISSIONS);
});

securityRouter.use(settingsRouter);
securityRouter.use(rolesRouter);
securityRouter.use(deviceApprovalsRouter);
securityRouter.use(joinRequestsRouter);
securityRouter.use(deviceLocksRouter);
securityRouter.use(auditLogRouter);
