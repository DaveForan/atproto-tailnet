import { api } from "./api";
import { inviteeBody } from "./invitations";
import type { OperatorOverview, OperatorSettings, TailnetCreator } from "../lib/types";

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export const operatorService = {
  overview: () => api<OperatorOverview>("/api/operator/overview"),

  getSettings: () => api<OperatorSettings>("/api/operator/settings"),

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

  setUserDisabled: (userId: string, disabled: boolean) =>
    api(`/api/operator/users/${userId}/${disabled ? "disable" : "enable"}`, json("POST")),
};
