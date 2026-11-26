import { tenantApi } from "./api";
import type { IpConfig, DerpConfig, RouteData } from "../lib/types";

export const networkService = {
  getIpConfig: (tid: string) =>
    tenantApi<IpConfig>(tid, "/ip-config"),

  getDerp: (tid: string) =>
    tenantApi<DerpConfig>(tid, "/derp"),

  setDerp: (tid: string, config: DerpConfig) =>
    tenantApi(tid, "/derp", {
      method: "PUT",
      body: JSON.stringify(config),
    }),

  getRoutes: (tid: string) =>
    tenantApi<RouteData>(tid, "/routes"),

  setRouteEnabled: (tid: string, routeId: string, enabled: boolean) =>
    tenantApi(tid, `/routes/${routeId}/${enabled ? "enable" : "disable"}`, { method: "POST" }),

  deleteRoute: (tid: string, routeId: string) =>
    tenantApi(tid, `/routes/${routeId}`, { method: "DELETE" }),

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
