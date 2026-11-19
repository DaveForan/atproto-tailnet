import { tenantApi } from "./api";
import type { NotificationList, WebhookTestResult } from "../lib/types";

export const notificationService = {
  list: (tid: string, opts: { unread?: boolean; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.unread) q.set("unread", "1");
    q.set("limit", String(opts.limit ?? 50));
    return tenantApi<NotificationList>(tid, `/notifications?${q}`);
  },

  unreadCount: (tid: string) =>
    notificationService.list(tid, { unread: true, limit: 1 }).then((r) => r?.unreadCount ?? 0),

  markRead: (tid: string, ids: string[]) =>
    tenantApi<{ unreadCount: number }>(tid, "/notifications/read", {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),

  markAllRead: (tid: string) =>
    tenantApi<{ unreadCount: number }>(tid, "/notifications/read", {
      method: "POST",
      body: JSON.stringify({ all: true }),
    }),

  testWebhook: (tid: string) =>
    tenantApi<WebhookTestResult>(tid, "/notifications/webhook/test", { method: "POST" }),
};
