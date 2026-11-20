/**
 * @module routes/audit-log
 * Paginated tenant audit log (`view_audit_log`).
 */

import { Router } from "express";
import { eq, and, desc, count } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, auditLogs } from "../db/schema.js";
import { requireAuth, param } from "./helpers.js";
import { tenantGuard } from "./guard.js";

export const auditLogRouter = Router();

// ── Audit log ───────────────────────────────────────────────────────

auditLogRouter.get(
  "/api/tenants/:tenantId/audit-log",
  requireAuth,
  tenantGuard({ permission: "view_audit_log" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");

    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;
    const actionFilter = req.query.action as string | undefined;

    const conditions = [eq(auditLogs.tenantId, tenantId)];
    if (actionFilter) {
      conditions.push(eq(auditLogs.action, actionFilter as typeof auditLogs.action.enumValues[number]));
    }

    const [entries, [totalRow]] = await Promise.all([
      db
        .select({
          id: auditLogs.id,
          actorHandle: users.handle,
          actorDisplayName: users.displayName,
          action: auditLogs.action,
          targetType: auditLogs.targetType,
          targetId: auditLogs.targetId,
          metadata: auditLogs.metadata,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .innerJoin(users, eq(auditLogs.actorUserId, users.id))
        .where(and(...conditions))
        .orderBy(desc(auditLogs.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ total: count() })
        .from(auditLogs)
        .where(and(...conditions)),
    ]);

    res.json({ entries, total: totalRow.total });
  },
);
