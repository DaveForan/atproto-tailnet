import { tenantApi } from "./api";
import type { Ancestor, SubCollective, ComplianceData } from "../lib/types";

export const collectivesService = {
  getAll: (tid: string) =>
    Promise.all([
      tenantApi<Ancestor[]>(tid, "/ancestors"),
      tenantApi<SubCollective[]>(tid, "/collectives"),
      tenantApi<ComplianceData>(tid, "/compliance"),
    ]).then(([ancestors, collectives, compliance]) => ({
      ancestors: ancestors ?? [],
      collectives: collectives ?? [],
      compliance,
    })),

  create: (tid: string, name: string, slug: string) =>
    tenantApi(tid, "/collectives", {
      method: "POST",
      body: JSON.stringify({ name, slug }),
    }),

  eject: (tid: string, id: string) =>
    tenantApi(tid, `/collectives/${id}`, { method: "DELETE" }),
};
