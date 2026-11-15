import { tenantApi } from "./api";
import type { UsageData } from "../lib/types";

export const usageService = {
  getUsage: (tid: string) =>
    tenantApi<UsageData>(tid, "/usage"),

  setPlan: (tid: string, planName: string, maxDevices: number, maxMembers: number) =>
    tenantApi(tid, "/plan", {
      method: "PUT",
      body: JSON.stringify({ planName, maxDevices, maxMembers }),
    }),
};
