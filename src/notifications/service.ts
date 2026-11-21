/**
 * @module notifications/service
 * Dashboard notifications + per-tenant webhook fan-out.
 *
 * {@link createNotification} resolves recipients at creation time — the
 * originator plus every member whose role holds the permission that lets
 * them act on the event — stores one row per recipient, and fires the
 * tenant's webhook in the background. It never throws: notification failures
 * must not break the request that triggered them.
 */

import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { memberships, notifications, roles, tenants } from "../db/schema.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { deliverWebhook, type WebhookPayload, type WebhookResult } from "./webhook.js";

export const NOTIFICATION_TYPES = [
  "device_approval_requested",
  "join_request",
  "service_device_approval_requested",
  "service_approval_requested",
  "device_limit_reached",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Permission a member needs (at creation time) to receive each type. */
export const NOTIFICATION_PERMISSION: Record<NotificationType, string> = {
  device_approval_requested: "approve_devices",
  join_request: "approve_joins",
  service_device_approval_requested: "approve_services",
  service_approval_requested: "approve_services",
  device_limit_reached: "approve_devices",
};

export interface NotificationContent {
  title: string;
  body?: string;
  link?: string | null;
}

/** Minimal member view used to pick recipients. */
export interface RecipientCandidate {
  userId: string;
  isOriginator: boolean;
  permissions: string[] | null;
}

/** Originator + members whose role has the matching permission (deduplicated). */
export function selectRecipients(
  members: RecipientCandidate[],
  type: NotificationType,
): string[] {
  const needed = NOTIFICATION_PERMISSION[type];
  const out = new Set<string>();
  for (const m of members) {
    if (m.isOriginator || (m.permissions ?? []).includes(needed)) out.add(m.userId);
  }
  return [...out];
}

/** Fire-and-forget webhook delivery with logging. */
export function fireWebhook(
  url: string,
  secret: string | null,
  payload: WebhookPayload,
): void {
  setImmediate(() => {
    void deliverWebhook(url, secret, payload, { allowPrivate: config.webhookAllowPrivate })
      .then((r: WebhookResult) => {
        if (!r.ok) {
          logger.warn({ tenantId: payload.tenantId, type: payload.type, status: r.status, error: r.error }, "notification webhook failed");
        }
      })
      .catch(() => {});
  });
}

/**
 * Create a notification for every eligible member of the tenant and fire
 * the tenant webhook. Returns the number of recipients (0 on error).
 *
 * @param opts.dedupeWindowMs - skip if the same type was already raised for
 *   this tenant within the window (used for noisy events like limit hits).
 */
export async function createNotification(
  tenantId: string,
  type: NotificationType,
  content: NotificationContent,
  opts: { dedupeWindowMs?: number } = {},
): Promise<number> {
  try {
    const [tenant] = await db
      .select({
        id: tenants.id,
        slug: tenants.slug,
        webhookUrl: tenants.notificationWebhookUrl,
        webhookSecret: tenants.notificationWebhookSecret,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (!tenant) return 0;

    if (opts.dedupeWindowMs) {
      const recent = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.tenantId, tenantId),
            eq(notifications.type, type),
            gt(notifications.createdAt, new Date(Date.now() - opts.dedupeWindowMs)),
          ),
        )
        .limit(1);
      if (recent.length > 0) return 0;
    }

    const members = await db
      .select({
        userId: memberships.userId,
        isOriginator: memberships.isOriginator,
        permissions: roles.permissions,
      })
      .from(memberships)
      .leftJoin(roles, eq(memberships.roleId, roles.id))
      .where(eq(memberships.tenantId, tenantId));

    const recipients = selectRecipients(members as RecipientCandidate[], type);
    const createdAt = new Date();
    const { title, body, link } = clip(content);

    if (recipients.length > 0) {
      await db.insert(notifications).values(
        recipients.map((userId) => ({ tenantId, userId, type, title, body, link, createdAt })),
      );
    }

    if (tenant.webhookUrl) {
      fireWebhook(tenant.webhookUrl, tenant.webhookSecret, {
        type,
        tenantId,
        tenantSlug: tenant.slug,
        title,
        body,
        link,
        createdAt: createdAt.toISOString(),
      });
    }
    return recipients.length;
  } catch (err) {
    logger.error({ tenantId, type, err }, "failed to create notification");
    return 0;
  }
}

/** Types of notifications addressed to one member. */
export const USER_NOTIFICATION_TYPES = [
  "device_trust",
  "friend_request",
  "friend_accepted",
  "friend_removed",
  "machine_refused",
  "service_post_approved",
  "service_post_rejected",
  "service_post_removed",
  "share_offered",
  "share_requested",
  "share_active",
  "share_ended",
] as const;

export type UserNotificationType = (typeof USER_NOTIFICATION_TYPES)[number];

/** Same limits as {@link createNotification}. */
function clip(content: NotificationContent): { title: string; body: string; link: string | null } {
  return { title: content.title.slice(0, 200), body: (content.body ?? "").slice(0, 2000), link: content.link ?? null };
}

/**
 * Notifies one member (friend requests, shares, review outcomes). Fire and
 * forget: a failed notification never fails the action that caused it.
 */
export function notifyUser(
  tenantId: string,
  userId: string,
  type: UserNotificationType,
  content: NotificationContent,
): void {
  void db
    .insert(notifications)
    .values({ tenantId, userId, type, ...clip(content) })
    .catch((err: unknown) => logger.warn({ tenantId, type, err }, "failed to create notification"));
}

/** Fire-and-forget wrapper for route handlers; never blocks or throws. */
export function notify(
  tenantId: string,
  type: NotificationType,
  content: NotificationContent,
  opts?: { dedupeWindowMs?: number },
): void {
  void createNotification(tenantId, type, content, opts);
}

/** Unread count for one member in one tenant. */
export async function unreadCount(tenantId: string, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        eq(notifications.tenantId, tenantId),
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
      ),
    );
  return row?.n ?? 0;
}

/** Mark notifications read (own rows only); `ids` undefined = all. */
export async function markRead(
  tenantId: string,
  userId: string,
  ids?: string[],
): Promise<void> {
  const filters = [
    eq(notifications.tenantId, tenantId),
    eq(notifications.userId, userId),
    isNull(notifications.readAt),
  ];
  if (ids) {
    if (ids.length === 0) return;
    filters.push(inArray(notifications.id, ids));
  }
  await db.update(notifications).set({ readAt: new Date() }).where(and(...filters));
}
