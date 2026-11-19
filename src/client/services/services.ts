import { tenantApi } from "./api";
import type { ServiceDevice, Service, BoardPost } from "../lib/types";

export const servicesService = {
  getServiceDevices: (tid: string) =>
    tenantApi<ServiceDevice[]>(tid, "/service-devices"),

  getServices: (tid: string) =>
    tenantApi<Service[]>(tid, "/services"),

  getAll: (tid: string) =>
    Promise.all([
      tenantApi<ServiceDevice[]>(tid, "/service-devices"),
      tenantApi<Service[]>(tid, "/services"),
    ]).then(([devices, services]) => ({
      devices: devices ?? [],
      services: services ?? [],
    })),

  registerDevice: (tid: string, name: string, description: string) =>
    tenantApi(tid, "/service-devices", {
      method: "POST",
      body: JSON.stringify({ name, description }),
    }),

  approveDevice: (tid: string, id: string) =>
    tenantApi(tid, `/service-devices/${id}/approve`, { method: "POST" }),

  rejectDevice: (tid: string, id: string) =>
    tenantApi(tid, `/service-devices/${id}/reject`, { method: "POST" }),

  removeDevice: (tid: string, id: string) =>
    tenantApi(tid, `/service-devices/${id}`, { method: "DELETE" }),

  registerService: (
    tid: string,
    body: { name: string; url: string; description?: string; serviceDeviceId: string },
  ) =>
    tenantApi(tid, "/services", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  approveService: (tid: string, id: string) =>
    tenantApi(tid, `/services/${id}/approve`, { method: "POST" }),

  rejectService: (tid: string, id: string) =>
    tenantApi(tid, `/services/${id}/reject`, { method: "POST" }),

  removeService: (tid: string, id: string) =>
    tenantApi(tid, `/services/${id}`, { method: "DELETE" }),

  getBoardPosts: (tid: string) =>
    tenantApi<BoardPost[]>(tid, "/board-posts"),

  createBoardPost: (
    tid: string,
    body: { title: string; description?: string; serviceId: string },
  ) =>
    tenantApi(tid, "/board-posts", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  removeBoardPost: (tid: string, id: string) =>
    tenantApi(tid, `/board-posts/${id}`, { method: "DELETE" }),
};
