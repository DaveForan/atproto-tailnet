import { tenantApi } from "./api";
import type { AuditLogPage } from "../lib/types";

export const auditService = {
  getAuditLog: (tid: string, limit: number, offset: number) =>
    tenantApi<AuditLogPage>(tid, `/audit-log?limit=${limit}&offset=${offset}`),
};
