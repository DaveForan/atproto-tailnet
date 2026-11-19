import { tenantApi } from "./api";
import type { UsageData } from "../lib/types";
import type { PlanName } from "../lib/constants";

export const usageService = {
  getUsage: (tid: string) =>
    tenantApi<UsageData>(tid, "/usage"),

  setPlan: (
    tid: string,
    body: { planName?: PlanName; maxDevices?: number; maxMembers?: number },
  ) =>
    tenantApi(tid, "/plan", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
};
