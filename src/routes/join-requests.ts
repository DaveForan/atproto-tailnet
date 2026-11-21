/**
 * @module routes/join-requests
 * Join requests: any signed-in user submits one and reads their own;
 * `approve_joins` holders list, approve (creates the membership) and reject.
 */

import { Router } from "express";
import { z } from "zod";
import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { memberships, users, joinRequests, tenants } from "../db/schema.js";
import { getControlClient } from "../orchestrator/control-client.js";
import { requireAuth, param, toHsUsername, authUserId } from "./helpers.js";
import { tenantGuard, tenantCtx } from "./guard.js";
import { logAudit } from "../audit/log.js";
import { enforceMemberLimit } from "./limits.js";
import { notify } from "../notifications/service.js";
import { parseBody } from "./validation.js";

export const joinRequestsRouter = Router({ caseSensitive: true });

/** Max pending join requests a tailnet queues before refusing new ones. */
export const MAX_PENDING_JOIN_REQUESTS = 50;
/** How long a rejected requester must wait before asking again. */
export const JOIN_REJECT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** One notification per requester per tailnet within this window. */
export const JOIN_NOTIFY_DEDUPE_MS = 24 * 60 * 60 * 1000;


const joinRequestBody = z.object({
  message: z.string().max(500).nullish(),
});

/** Submit a join request. Requires auth but NOT membership. */
joinRequestsRouter.post(
  "/api/tenants/:id/join-requests",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "id");
    const userId = authUserId(req);
    const body = parseBody(joinRequestBody, req, res, { emptyAsObject: true });
    if (!body) return;

    const [tenant] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, tenantId));

    if (!tenant || tenant.status === "deleted" || tenant.suspended) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!tenant.allowJoinRequests) {
      res.status(403).json({ error: "This tailnet is not accepting join requests" });
      return;
    }

    if (tenant.lockdownMode) {
      res.status(403).json({ error: "Tenant is in lockdown mode" });
      return;
    }

    const [existing] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)));

    if (existing) {
      res.status(409).json({ error: "You are already a member" });
      return;
    }

    // Latest earlier request by this requester: already pending (409),
    // rejection cooldown (429), and notification dedupe.
    const [previous] = await db
      .select({
        status: joinRequests.status,
        requestedAt: joinRequests.requestedAt,
        reviewedAt: joinRequests.reviewedAt,
      })
      .from(joinRequests)
      .where(and(eq(joinRequests.tenantId, tenantId), eq(joinRequests.requesterId, userId)))
      .orderBy(desc(joinRequests.requestedAt))
      .limit(1);

    if (previous?.status === "pending") {
      res.status(409).json({ error: "You already have a pending request", code: "join_request_pending" });
      return;
    }

    const now = Date.now();
    if (previous?.status === "rejected") {
      const rejectedAt = (previous.reviewedAt ?? previous.requestedAt).getTime();
      const retryAfter = Math.ceil((rejectedAt + JOIN_REJECT_COOLDOWN_MS - now) / 1000);
      if (retryAfter > 0) {
        res.setHeader("Retry-After", String(retryAfter));
        res.status(429).json({
          error: "Your previous request was declined. Please wait before asking again.",
          code: "join_cooldown",
          retryAfter,
        });
        return;
      }
    }

    const [{ pending }] = await db
      .select({ pending: sql<number>`count(*)::int` })
      .from(joinRequests)
      .where(and(eq(joinRequests.tenantId, tenantId), eq(joinRequests.status, "pending")));

    if (pending >= MAX_PENDING_JOIN_REQUESTS) {
      res.status(429).json({
        error: "This tailnet has too many pending join requests. Try again later.",
        code: "join_queue_full",
      });
      return;
    }

    const safeMessage = body.data.message || null;

    let created: typeof joinRequests.$inferSelect | undefined;
    try {
      [created] = await db
        .insert(joinRequests)
        .values({
          tenantId,
          requesterId: userId,
          message: safeMessage,
        })
        .returning();
    } catch (err: unknown) {
      // join_requests_pending_uq: a concurrent request won the race
      if ((err as { code?: string }).code === "23505") {
        res.status(409).json({ error: "You already have a pending request", code: "join_request_pending" });
        return;
      }
      throw err;
    }
    if (!created) {
      res.status(500).json({ error: "Failed to create join request" });
      return;
    }

    logAudit({
      tenantId,
      actorUserId: userId,
      action: "join_request_created",
      targetType: "join_request",
      targetId: created.id,
    });

    // Dedupe: a requester who already asked within the window (e.g. rejected
    // then re-requested) doesn't raise another notification / webhook.
    const recentlyNotified =
      previous !== undefined && now - previous.requestedAt.getTime() < JOIN_NOTIFY_DEDUPE_MS;
    if (!recentlyNotified) {
      const [requester] = await db
        .select({ handle: users.handle })
        .from(users)
        .where(eq(users.id, userId));
      notify(tenantId, "join_request", {
        title: "New join request",
        body: `@${requester?.handle ?? "someone"} asked to join ${tenant.name}.`,
        link: "/#security",
      });
    }

    res.status(201).json({ id: created.id, status: "pending" });
  },
);

/** Check the user's own join request status for a tenant. */
joinRequestsRouter.get(
  "/api/tenants/:id/join-requests/mine",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "id");
    const userId = authUserId(req);

    const rows = await db
      .select()
      .from(joinRequests)
      .where(
        and(
          eq(joinRequests.tenantId, tenantId),
          eq(joinRequests.requesterId, userId),
        ),
      );

    res.json(
      rows.map((r) => ({
        id: r.id,
        status: r.status,
        message: r.message,
        requestedAt: r.requestedAt,
        reviewedAt: r.reviewedAt,
      })),
    );
  },
);

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
      await client.createUser?.(hsUsername);
    } catch {
      // User might already exist
    }

    await db.insert(memberships).values({
      userId: request.requesterId,
      tenantId,
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
