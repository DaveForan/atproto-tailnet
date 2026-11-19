import { api } from "./api";
import type { McpConnection } from "../lib/types";

export const mcpService = {
  connections: () =>
    api<McpConnection[]>("/api/mcp/connections").then((r) => r ?? []),

  revoke: (id: string) =>
    api(`/api/mcp/connections/${id}`, { method: "DELETE" }),
};
