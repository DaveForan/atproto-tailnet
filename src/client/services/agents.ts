import { tenantApi } from "./api";
import type { AgentToken } from "../lib/types";

export const agentsService = {
  getAgentTokens: (tid: string) =>
    tenantApi<AgentToken[]>(tid, "/agent-tokens"),

  createAgentToken: (
    tid: string,
    body: { name: string; expiresInDays: number; permissions: string[] },
  ) =>
    tenantApi<{ token: string }>(tid, "/agent-tokens", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  revokeAgentToken: (tid: string, id: string) =>
    tenantApi(tid, `/agent-tokens/${id}/revoke`, { method: "POST" }),
};
