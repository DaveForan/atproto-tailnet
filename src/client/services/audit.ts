import { tenantApi } from "./api";
import type { AuditEntry } from "../lib/types";

export const auditService = {
  getAuditLog: (tid: string, limit: number, offset: number) =>
    tenantApi<AuditEntry[]>(tid, `/audit-log?limit=${limit}&offset=${offset}`),
};
