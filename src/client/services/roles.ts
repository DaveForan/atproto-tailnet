import { tenantApi } from "./api";
import type { Role } from "../lib/types";

export const rolesService = {
  getRoles: (tid: string) =>
    tenantApi<Role[]>(tid, "/roles"),

  createRole: (tid: string, name: string, permissions: string[]) =>
    tenantApi(tid, "/roles", {
      method: "POST",
      body: JSON.stringify({ name, permissions }),
    }),

  updateRole: (tid: string, id: string, permissions: string[]) =>
    tenantApi(tid, `/roles/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ permissions }),
    }),

  deleteRole: (tid: string, id: string) =>
    tenantApi(tid, `/roles/${id}`, { method: "DELETE" }),

  setDefaultRole: (tid: string, id: string) =>
    tenantApi(tid, "/default-role", {
      method: "PATCH",
      body: JSON.stringify({ roleId: id }),
    }),
};
