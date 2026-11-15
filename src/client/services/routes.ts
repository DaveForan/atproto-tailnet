import { tenantApi } from "./api";
import type { RouteData } from "../lib/types";

export const routesService = {
  getRoutes: (tid: string) =>
    tenantApi<RouteData>(tid, "/routes"),

  enableRoute: (tid: string, id: string) =>
    tenantApi(tid, `/routes/${id}/enable`, { method: "POST" }),

  disableRoute: (tid: string, id: string) =>
    tenantApi(tid, `/routes/${id}/disable`, { method: "POST" }),

  deleteRoute: (tid: string, id: string) =>
    tenantApi(tid, `/routes/${id}`, { method: "DELETE" }),
};
