import { tenantApi } from "./api";
import type { Ancestor, SubCollective, ComplianceData } from "../lib/types";

export const collectivesService = {
  ancestors: (tid: string) => tenantApi<Ancestor[]>(tid, "/ancestors"),
  list: (tid: string) => tenantApi<SubCollective[]>(tid, "/collectives"),
  compliance: (tid: string) => tenantApi<ComplianceData>(tid, "/compliance"),

  create: (tid: string, name: string, slug: string) =>
    tenantApi(tid, "/collectives", {
      method: "POST",
      body: JSON.stringify({ name, slug }),
    }),

  eject: (tid: string, id: string) =>
    tenantApi(tid, `/collectives/${id}/eject`, { method: "POST" }),
};
