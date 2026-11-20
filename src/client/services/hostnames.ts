import { tenantApi } from "./api";
import type { HostnamesData, TailnetHostname } from "../lib/types";

export const hostnamesService = {
  list: (tid: string) => tenantApi<HostnamesData>(tid, "/hostnames"),

  setPrimary: (tid: string, name: string) =>
    tenantApi<{ primary: string; hostnames: TailnetHostname[] }>(tid, "/hostnames/primary", {
      method: "PUT",
      body: JSON.stringify({ name }),
    }),

  retire: (tid: string, name: string) =>
    tenantApi<{ hostnames: TailnetHostname[] }>(tid, `/hostnames/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),
};
