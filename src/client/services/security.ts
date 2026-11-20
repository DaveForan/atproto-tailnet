import { tenantApi } from "./api";
import type {
  Settings,
  DeviceApproval,
  JoinRequest,
} from "../lib/types";

export const securityService = {
  getSettings: (tid: string) =>
    tenantApi<Settings>(tid, "/settings"),

  getAll: (tid: string) =>
    Promise.all([
      tenantApi<Settings>(tid, "/settings"),
      tenantApi<DeviceApproval[]>(tid, "/device-approvals"),
      tenantApi<JoinRequest[]>(tid, "/join-requests"),
    ]).then(([settings, approvals, joinRequests]) => ({
      settings,
      approvals: approvals ?? [],
      joinRequests: joinRequests ?? [],
    })),

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

  approveDevice: (tid: string, id: string) =>
    tenantApi(tid, `/device-approvals/${id}/approve`, { method: "POST" }),

  rejectDevice: (tid: string, id: string) =>
    tenantApi(tid, `/device-approvals/${id}/reject`, { method: "POST" }),

  approveJoin: (tid: string, id: string) =>
    tenantApi(tid, `/join-requests/${id}/approve`, { method: "POST" }),

  rejectJoin: (tid: string, id: string) =>
    tenantApi(tid, `/join-requests/${id}/reject`, { method: "POST" }),
};
