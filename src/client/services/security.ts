import { tenantApi } from "./api";
import type {
  Settings,
  JoinRequest,
} from "../lib/types";

export const securityService = {
  getSettings: (tid: string) =>
    tenantApi<Settings>(tid, "/settings"),

  joinRequests: (tid: string) => tenantApi<JoinRequest[]>(tid, "/join-requests"),

  updateSetting: (tid: string, key: string, value: boolean | number) =>
    tenantApi(tid, "/settings", {
      method: "PATCH",
      body: JSON.stringify({ [key]: value }),
    }),

  updateWebhook: (
    tid: string,
    body: { notificationWebhookUrl?: string | null; notificationWebhookSecret?: string | null },
  ) =>
    tenantApi(tid, "/settings", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  approveJoin: (tid: string, id: string) =>
    tenantApi(tid, `/join-requests/${id}/approve`, { method: "POST" }),

  rejectJoin: (tid: string, id: string) =>
    tenantApi(tid, `/join-requests/${id}/reject`, { method: "POST" }),
};
