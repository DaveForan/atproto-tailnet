import { api, apiOrNull } from "./api";
import type { Invitation, Tenant, User } from "../lib/types";

export const sessionService = {
  /** The signed-in user, or null when nobody is signed in. */
  me: () => apiOrNull<User>("/api/me"),
  tenants: () => api<Tenant[]>("/api/tenants").then((r) => r ?? []),
  invitations: () => api<Invitation[]>("/api/invitations").then((r) => r ?? []),
  permissions: () => api<string[]>("/api/permissions").then((r) => r ?? []),
  /** 200 for members, 404 otherwise. */
  tenant: (id: string) => api<Tenant>(`/api/tenants/${id}`),
};
