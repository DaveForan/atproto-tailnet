import { api } from "./api";
import { inviteeBody } from "./invitations";
import type { OperatorAuditPage, OperatorOverview, OperatorSettings, TailnetCreator } from "../lib/types";

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export const operatorService = {
  overview: () => api<OperatorOverview>("/api/operator/overview"),

  updateSettings: (patch: Partial<OperatorSettings>) =>
    api<OperatorSettings>("/api/operator/settings", json("PUT", patch)),

  getCreators: () =>
    api<{ creators: TailnetCreator[] }>("/api/operator/tailnet-creators").then((r) => r?.creators ?? []),

  addCreator: (input: string) =>
    api<TailnetCreator>("/api/operator/tailnet-creators", json("POST", inviteeBody(input))),

  removeCreator: (id: string) =>
    api(`/api/operator/tailnet-creators/${id}`, json("DELETE")),

  setSuspended: (tenantId: string, suspended: boolean) =>
    api(`/api/operator/tenants/${tenantId}/${suspended ? "suspend" : "unsuspend"}`, json("POST")),

  deleteTenant: (tenantId: string) =>
    api(`/api/operator/tenants/${tenantId}`, json("DELETE")),

  audit: (limit = 50, offset = 0) =>
    api<OperatorAuditPage>(`/api/operator/audit?limit=${limit}&offset=${offset}`),

  setUserDisabled: (userId: string, disabled: boolean) =>
    api(`/api/operator/users/${userId}/${disabled ? "disable" : "enable"}`, json("POST")),
};
