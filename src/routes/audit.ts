import { db } from "../db/index.js";
import { auditLogs, auditActionEnum } from "../db/schema.js";

type AuditAction = (typeof auditActionEnum.enumValues)[number];

/**
 * Records a security-relevant action in the append-only audit log.
 * Fire-and-forget — never blocks the caller on failure.
 */
export function logAudit(params: {
  tenantId: string;
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
    .catch((err) => console.error("Audit log write failed:", err));
}
