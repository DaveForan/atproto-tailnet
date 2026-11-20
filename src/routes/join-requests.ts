/**
 * @module routes/join-requests
 * Join-request review for `approve_joins` holders: list, approve (creates the
 * membership) and reject. Submitting a request lives in routes/api.ts.
 */

import { Router } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import { memberships, users, joinRequests } from "../db/schema.js";
import { getControlClient } from "../orchestrator/control-client.js";
import { requireAuth, param, toHsUsername, authUserId } from "./helpers.js";
import { tenantGuard, tenantCtx } from "./guard.js";
import { logAudit } from "../audit/log.js";
import { enforceMemberLimit } from "./limits.js";

export const joinRequestsRouter = Router();

// ── Join requests ───────────────────────────────────────────────────

joinRequestsRouter.get(
  "/api/tenants/:tenantId/join-requests",
  requireAuth,
  tenantGuard({ permission: "approve_joins" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");

    const rows = await db
      .select({
        id: joinRequests.id,
        requesterId: joinRequests.requesterId,
        requesterHandle: users.handle,
        requesterDisplayName: users.displayName,
        requesterAvatarUrl: users.avatarUrl,
        message: joinRequests.message,
        status: joinRequests.status,
        requestedAt: joinRequests.requestedAt,
        reviewedAt: joinRequests.reviewedAt,
      })
      .from(joinRequests)
      .innerJoin(users, eq(joinRequests.requesterId, users.id))
      .where(eq(joinRequests.tenantId, tenantId))
      .orderBy(desc(joinRequests.requestedAt))
      .limit(200);

    res.json(rows);
  },
);

joinRequestsRouter.post(
  "/api/tenants/:tenantId/join-requests/:requestId/approve",
  requireAuth,
  tenantGuard({ permission: "approve_joins", notLockedDown: true }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const requestId = param(req, "requestId");
    const result = tenantCtx(res);

    const [request] = await db
      .select()
      .from(joinRequests)
      .where(
        and(
          eq(joinRequests.id, requestId),
          eq(joinRequests.tenantId, tenantId),
          eq(joinRequests.status, "pending"),
        ),
      );

    if (!request) {
      res.status(404).json({ error: "Pending join request not found" });
      return;
    }

    if (!(await enforceMemberLimit(res, result.tenant))) return;

    const [requester] = await db
      .select()
      .from(users)
      .where(eq(users.id, request.requesterId));

    const hsUsername = toHsUsername(requester.handle);

    try {
      const client = getControlClient(result.tenant);
      await client.createUser(hsUsername);
    } catch {
      // User might already exist
    }

    await db.insert(memberships).values({
      userId: request.requesterId,
      tenantId,
      role: "member",
      roleId: result.tenant.defaultRoleId,
      isOriginator: false,
    }).onConflictDoNothing();

    await db
      .update(joinRequests)
      .set({
        status: "approved",
        reviewedById: authUserId(req),
        reviewedAt: new Date(),
      })
      .where(eq(joinRequests.id, requestId));

    logAudit({
      tenantId,
      actorUserId: authUserId(req),
      action: "join_request_approved",
      targetType: "join_request",
      targetId: requestId,
      metadata: { handle: requester.handle },
    });

    res.json({ status: "approved" });
  },
);

joinRequestsRouter.post(
  "/api/tenants/:tenantId/join-requests/:requestId/reject",
  requireAuth,
  tenantGuard({ permission: "approve_joins" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const requestId = param(req, "requestId");

    const [request] = await db
      .select()
      .from(joinRequests)
      .where(
        and(
          eq(joinRequests.id, requestId),
          eq(joinRequests.tenantId, tenantId),
          eq(joinRequests.status, "pending"),
        ),
      );

    if (!request) {
      res.status(404).json({ error: "Pending join request not found" });
      return;
    }

    await db
      .update(joinRequests)
      .set({
        status: "rejected",
        reviewedById: authUserId(req),
        reviewedAt: new Date(),
      })
      .where(eq(joinRequests.id, requestId));

    logAudit({
      tenantId,
      actorUserId: authUserId(req),
      action: "join_request_rejected",
      targetType: "join_request",
      targetId: requestId,
      metadata: { requesterId: request.requesterId },
    });

    res.json({ status: "rejected" });
  },
);
