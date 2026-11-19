import { tenantApi } from "./api";
import type { UsageData, UsageLimits } from "../lib/types";

export const usageService = {
  getUsage: (tid: string) =>
    tenantApi<UsageData>(tid, "/usage"),

  setLimits: (tid: string, body: Partial<UsageLimits>) =>
    tenantApi(tid, "/limits", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
};
