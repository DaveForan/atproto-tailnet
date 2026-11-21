/**
 * Audit log writer. The read API is in routes/security.ts.
 */

import { db } from "../db/index.js";
import { auditLogs, auditActionEnum } from "../db/schema.js";
import { logger } from "../logger.js";

type AuditAction = (typeof auditActionEnum.enumValues)[number];

/** Appends a security-relevant action to the audit log. A failure is logged and never blocks the caller. */
export function logAudit(params: {
  /** NULL for instance-level operator actions not tied to one tenant. */
  tenantId: string | null;
  actorUserId: string;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}): void {
  db.insert(auditLogs)
    .values({
      tenantId: params.tenantId,
      actorUserId: params.actorUserId,
      action: params.action,
      targetType: params.targetType ?? null,
      targetId: params.targetId ?? null,
      metadata: params.metadata ?? null,
    })
    .catch((err) => logger.error({ err }, "audit log write failed"));
}
