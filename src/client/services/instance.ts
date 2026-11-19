import { api } from "./api";
import type { InstanceInfo, MyJoinRequest, PublicTenant } from "../lib/types";

export const instanceService = {
  get: () => api<InstanceInfo>("/api/instance"),

  publicTenant: (slug: string) =>
    api<PublicTenant>(`/api/tenants/by-slug/${encodeURIComponent(slug)}/public`),

  myJoinRequests: (tid: string) =>
    api<MyJoinRequest[]>(`/api/tenants/${tid}/join-requests/mine`),

  requestToJoin: (tid: string, message: string) =>
    api(`/api/tenants/${tid}/join-requests`, {
      method: "POST",
      body: JSON.stringify({ message: message.trim() || undefined }),
    }),
};
