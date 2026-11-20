import { tenantApi } from "./api";
import type { UsageData } from "../lib/types";

export const usageService = {
  getUsage: (tid: string) => tenantApi<UsageData>(tid, "/usage"),

  setLimits: (tid: string, maxDevices: number, maxMembers: number) =>
    tenantApi(tid, "/limits", {
      method: "PUT",
      body: JSON.stringify({ maxDevices, maxMembers }),
    }),
};
