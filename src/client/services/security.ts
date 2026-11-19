import { tenantApi } from "./api";
import type {
  Settings,
  DeviceApproval,
  JoinRequest,
  ServiceDevice,
  Service,
} from "../lib/types";

export const securityService = {
  getSettings: (tid: string) =>
    tenantApi<Settings>(tid, "/settings"),

  getAll: (tid: string) =>
    Promise.all([
      tenantApi<Settings>(tid, "/settings"),
      tenantApi<DeviceApproval[]>(tid, "/device-approvals"),
      tenantApi<JoinRequest[]>(tid, "/join-requests"),
      tenantApi<ServiceDevice[]>(tid, "/service-devices"),
      tenantApi<Service[]>(tid, "/services"),
    ]).then(([settings, approvals, joinRequests, serviceDevices, services]) => ({
      settings,
      approvals: approvals ?? [],
      joinRequests: joinRequests ?? [],
      serviceDevices: serviceDevices ?? [],
      services: services ?? [],
    })),

  updateSetting: (tid: string, key: string, value: boolean | number) =>
    tenantApi(tid, "/settings", {
      method: "PATCH",
      body: JSON.stringify({ [key]: value }),
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
