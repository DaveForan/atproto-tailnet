import { tenantApi } from "./api";
import type { UsageData } from "../lib/types";

export const usageService = {
  getUsage: (tid: string) => tenantApi<UsageData>(tid, "/usage"),

  setLimits: (tid: string, limits: { maxDevices: number; maxMembers: number; waitingDeviceHours: number }) =>
    tenantApi(tid, "/limits", {
      method: "PUT",
      body: JSON.stringify(limits),
    }),
};
