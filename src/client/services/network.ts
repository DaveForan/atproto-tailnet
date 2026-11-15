import { tenantApi } from "./api";
import type { IpConfig, DerpConfig } from "../lib/types";

export const networkService = {
  // IP Configuration
  getIpConfig: (tid: string) =>
    tenantApi<IpConfig>(tid, "/ip-config"),

  setIpConfig: (tid: string, config: IpConfig) =>
    tenantApi(tid, "/ip-config", {
      method: "PUT",
      body: JSON.stringify(config),
    }),

  // DERP
  getDerp: (tid: string) =>
    tenantApi<DerpConfig>(tid, "/derp"),

  setDerp: (tid: string, config: DerpConfig) =>
    tenantApi(tid, "/derp", {
      method: "PUT",
      body: JSON.stringify(config),
    }),

  // Traversal
  getTraversalPolicy: (tid: string) =>
    tenantApi<unknown>(tid, "/traversal-policy"),

  setTraversalPolicy: (tid: string, policy: unknown) =>
    tenantApi(tid, "/traversal-policy", {
      method: "PUT",
      body: JSON.stringify(policy),
    }),

  evaluateTraversal: (tid: string, source: string, destination: string) =>
    tenantApi<{ allowed: boolean; matchedRule?: string; detail?: string }>(
      tid,
      "/traversal-policy/evaluate",
      { method: "POST", body: JSON.stringify({ source, destination }) },
    ),
};
