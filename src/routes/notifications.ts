/**
 * @module routes/notifications
 * Per-member dashboard notifications (list, mark read) and the tenant webhook
 * test endpoint. Webhook URL/secret are edited through PATCH /settings.
 */

import { Router } from "express";
import { z } from "zod";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { notifications } from "../db/schema.js";
import { config } from "../config.js";
import { deliverWebhook } from "../notifications/webhook.js";
import { markRead, unreadCount } from "../notifications/service.js";
import {
  requireAuth,
  param,
  getTenantForUser,
  hasPermission,
  authUserId,
} from "./helpers.js";

export const notificationsRouter = Router();

notificationsRouter.get(
  "/api/tenants/:tenantId/notifications",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const userId = authUserId(req);
    const result = await getTenantForUser(tenantId, userId);
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const unreadOnly = req.query.unread === "1" || req.query.unread === "true";
    const rawLimit = Number(req.query.limit ?? 50);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 50;

    const filters = [eq(notifications.tenantId, tenantId), eq(notifications.userId, userId)];
    if (unreadOnly) filters.push(isNull(notifications.readAt));

    const rows = await db
      .select({
        id: notifications.id,
        type: notifications.type,
        title: notifications.title,
        body: notifications.body,
        link: notifications.link,
        createdAt: notifications.createdAt,
        readAt: notifications.readAt,
      })
      .from(notifications)
      .where(and(...filters))
      .orderBy(desc(notifications.createdAt))
      .limit(limit);

    res.json({ notifications: rows, unreadCount: await unreadCount(tenantId, userId) });
  },
);

const readBody = z.union([
  z.object({ ids: z.array(z.string().uuid()).max(500) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);

notificationsRouter.post(
  "/api/tenants/:tenantId/notifications/read",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const userId = authUserId(req);
    const result = await getTenantForUser(tenantId, userId);
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const parsed = readBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
      return;
    }

    await markRead(tenantId, userId, "ids" in parsed.data ? parsed.data.ids : undefined);
    res.json({ unreadCount: await unreadCount(tenantId, userId) });
  },
);

notificationsRouter.post(
  "/api/tenants/:tenantId/notifications/webhook/test",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const userId = authUserId(req);
    const result = await getTenantForUser(tenantId, userId);
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }
    if (!hasPermission(result.membership, result.role, "manage_settings", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    const { tenant } = result;
    if (!tenant.notificationWebhookUrl) {
      res.status(400).json({ ok: false, error: "No webhook URL configured" });
      return;
    }

    const outcome = await deliverWebhook(
      tenant.notificationWebhookUrl,
      tenant.notificationWebhookSecret,
      {
        type: "webhook_test",
        tenantId,
        tenantSlug: tenant.slug,
        title: "Test notification",
        body: `Webhook test for ${tenant.name}`,
        link: null,
        createdAt: new Date().toISOString(),
      },
      { allowPrivate: config.webhookAllowPrivate },
    );
    res.json(outcome);
  },
);
