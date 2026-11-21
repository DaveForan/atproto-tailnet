import { tenantApi } from "./api";
import type {
  Settings,
  DeviceApproval,
  JoinRequest,
} from "../lib/types";

export const securityService = {
  getSettings: (tid: string) =>
    tenantApi<Settings>(tid, "/settings"),

  deviceApprovals: (tid: string) => tenantApi<DeviceApproval[]>(tid, "/device-approvals"),
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

  approveDevice: (tid: string, id: string) =>
    tenantApi(tid, `/device-approvals/${id}/approve`, { method: "POST" }),

  rejectDevice: (tid: string, id: string) =>
    tenantApi(tid, `/device-approvals/${id}/reject`, { method: "POST" }),

  approveJoin: (tid: string, id: string) =>
    tenantApi(tid, `/join-requests/${id}/approve`, { method: "POST" }),

  rejectJoin: (tid: string, id: string) =>
    tenantApi(tid, `/join-requests/${id}/reject`, { method: "POST" }),
};
