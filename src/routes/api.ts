/**
 * @module routes/api
 * Core API routes: health check, current-user info, tenant CRUD and
 * lifecycle (start/stop/delete), public tenant lookup, and join request
 * submission/status.
 */

import { Router } from "express";
import { config } from "../config.js";
import { eq, and, desc, ne, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { users, tenants, memberships, roles, joinRequests, invitations } from "../db/schema.js";
import {
  destroyInstance,
  startInstance,
  stopInstance,
} from "../orchestrator/headscale.js";
import { syncTenantRoutes } from "../orchestrator/caddy.js";
import { releaseTenantPort } from "../orchestrator/ports.js";
import { getCoordinatorClient, useCoordinator } from "../orchestrator/control-client.js";
import { requireAuth, param, getTenantForUser, authUserId } from "./helpers.js";
import { logAudit } from "../audit/log.js";
import { stepUpForSession } from "../auth/step-up.js";
import { checkTenantHealth } from "../orchestrator/monitor.js";
import { logger } from "../logger.js";
import {
  liveHostnamesByTenant,
  primaryHostname,
  tenantIdForHostname,
  tenantIdForPublicLink,
  tenantLoginServerFor,
} from "../orchestrator/hostnames.js";
import { notify } from "../notifications/service.js";
import {
  canCreateTailnet,
  memberAccess,
  withTailnetCreationLock,
  clearDefaultTailnetIf,
  getInstanceSettings,
  isOperatorDid,
} from "../operator/policy.js";
import { provisionTenant } from "../orchestrator/tenant-provisioning.js";

/**
 * Router for /health, /api/me, /api/tenants (list, detail, delete,
 * start, stop), public tenant lookup by slug, and join request endpoints.
 */
export const apiRouter = Router();

apiRouter.get("/health", async (_req, res) => {
  try {
    await db.select().from(users).limit(1);
    res.json({ status: "ok" });
  } catch {
    res.status(503).json({ status: "unhealthy" });
  }
});

apiRouter.get("/api/me", requireAuth, async (req, res) => {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, authUserId(req)));

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const [membership] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .innerJoin(tenants, eq(memberships.tenantId, tenants.id))
    .where(and(eq(memberships.userId, user.id), ne(tenants.status, "deleted")))
    .limit(1);

  // Instance powers never flow through tenant-scoped agent tokens
  const viaAgentToken = Boolean(req.agentToken);

  res.json({
    id: user.id,
    did: user.did,
    handle: user.handle,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    mustEnrollDevice: Boolean(req.session.mustEnrollDevice),
    isOperator: !viaAgentToken && isOperatorDid(user.did),
    canCreateTailnet: !viaAgentToken && (await canCreateTailnet(user)),
    access: membership ? await memberAccess(user.id) : "no_access",
    instance: { singleTailnet: (await getInstanceSettings()).singleTailnet },
    features: { federation: config.federationEnabled },
  });
});

const createTenantBody = z.object({
  name: z.string().trim().min(1).max(100).optional(),
});

/**
 * Create the signed-in user's own top-level tailnet via the normal
 * provisioning path — for operators / designated creators who weren't given
 * one at sign-in (e.g. designated after joining another tailnet). Gated by
 * canCreateTailnet; one originated top-level tailnet per user. Interactive
 * credentials only — never agent tokens.
 */
apiRouter.post("/api/tenants/mine", requireAuth, async (req, res) => {
  if (req.agentToken) {
    res.status(403).json({ error: "Agent tokens cannot create a tailnet" });
    return;
  }
  const parsed = createTenantBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
    return;
  }

  const [user] = await db.select().from(users).where(eq(users.id, authUserId(req)));
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  type Outcome =
    | { kind: "owned"; tenantId: string }
    | { kind: "forbidden" }
    | { kind: "created"; tenant: { id: string; slug: string; name: string; status: string } };
  let outcome: Outcome;
  try {
    outcome = await withTailnetCreationLock<Outcome>(async () => {
      const [owned] = await db
        .select({ id: tenants.id })
        .from(tenants)
        .innerJoin(memberships, and(eq(memberships.tenantId, tenants.id), eq(memberships.userId, user.id)))
        .where(
          and(
            eq(memberships.isOriginator, true),
            isNull(tenants.parentId),
            ne(tenants.status, "deleted"),
          ),
        )
        .limit(1);
      if (owned) return { kind: "owned", tenantId: owned.id };
      if (!(await canCreateTailnet(user))) return { kind: "forbidden" };
      const tenant = await provisionTenant(user, user.displayName ?? user.handle, user.handle, {
        name: parsed.data.name,
      });
      return { kind: "created", tenant };
    });
  } catch (err) {
    logger.error({ userId: user.id, err }, "failed to create tenant");
    res.status(500).json({ error: "Failed to create tailnet" });
    return;
  }

  if (outcome.kind === "owned") {
    res.status(409).json({ error: "You already have a tailnet", code: "already_has_tailnet", tenantId: outcome.tenantId });
    return;
  }
  if (outcome.kind === "forbidden") {
    res.status(403).json({
      error: "You are not allowed to create a tailnet on this instance",
      code: "cannot_create_tailnet",
    });
    return;
  }
  const { tenant } = outcome;
  res.status(201).json({ id: tenant.id, slug: tenant.slug, name: tenant.name, status: tenant.status });
});

apiRouter.get("/api/tenants", requireAuth, async (req, res) => {
  const userTenants = await db
    .select({
      id: tenants.id,
      slug: tenants.slug,
      name: tenants.name,
      status: tenants.status,
      suspended: tenants.suspended,
      isOriginator: memberships.isOriginator,
      roleName: roles.name,
      coordinatorTenantId: tenants.coordinatorTenantId,
    })
    .from(memberships)
    .innerJoin(tenants, eq(memberships.tenantId, tenants.id))
    .leftJoin(roles, eq(memberships.roleId, roles.id))
    .where(
      req.agentToken
        ? // An agent token is scoped to one tailnet: it sees only that one
          and(eq(memberships.userId, authUserId(req)), eq(tenants.id, req.agentToken.tenantId))
        : eq(memberships.userId, authUserId(req)),
    )
    .orderBy(desc(tenants.createdAt))
    .limit(200);

  const names = await liveHostnamesByTenant(userTenants.map((t) => t.id));
  res.json(
    userTenants.map(({ coordinatorTenantId, ...t }) => ({
      ...t,
      // Internal coordinator id: dashboard sessions only, never agent tokens
      ...(req.agentToken ? {} : { coordinatorTenantId }),
      address: names.get(t.id)?.[0] ?? t.slug,
      coordinatorMode: useCoordinator,
    })),
  );
});

apiRouter.get("/api/tenants/:id", requireAuth, async (req, res) => {
  const result = await getTenantForUser(param(req, "id"), authUserId(req));
  if (!result) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  res.json({
    id: result.tenant.id,
    slug: result.tenant.slug,
    name: result.tenant.name,
    status: result.tenant.status,
    suspended: result.tenant.suspended,
    isOriginator: result.membership.isOriginator,
    roleName: result.role?.name ?? null,
    roleId: result.membership.roleId,
    defaultRoleId: result.tenant.defaultRoleId,
    address: await primaryHostname(result.tenant.id, result.tenant.slug),
    loginServer: await tenantLoginServerFor(result.tenant),
    coordinatorTenantId: result.tenant.coordinatorTenantId ?? null,
    coordinatorMode: useCoordinator,
  });
});

/**
 * Public tenant info — no auth required. Only answers for tailnets that are
 * accepting join requests (and are not suspended, deleted or locked down);
 * everything else is 404 so the endpoint can't be used to probe which slugs
 * exist.
 */
apiRouter.get("/api/tenants/by-slug/:slug/public", async (req, res) => {
  const tenantId = await tenantIdForPublicLink(param(req, "slug"));

  const [tenant] = await db
    .select({
      id: tenants.id,
      slug: tenants.slug,
      name: tenants.name,
      allowJoinRequests: tenants.allowJoinRequests,
      lockdownMode: tenants.lockdownMode,
      status: tenants.status,
      suspended: tenants.suspended,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId ?? "00000000-0000-0000-0000-000000000000"));

  if (
    !tenant ||
    !tenant.allowJoinRequests ||
    tenant.lockdownMode ||
    tenant.suspended ||
    tenant.status === "deleted"
  ) {
    res.status(404).json({ error: "Tailnet not found" });
    return;
  }

  res.json({
    id: tenant.id,
    address: await primaryHostname(tenant.id, tenant.slug),
    name: tenant.name,
    joinOpen: true,
  });
});

/** Max pending join requests a tailnet queues before refusing new ones. */
export const MAX_PENDING_JOIN_REQUESTS = 50;
/** How long a rejected requester must wait before asking again. */
export const JOIN_REJECT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** One notification per requester per tailnet within this window. */
export const JOIN_NOTIFY_DEDUPE_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the TLS on-demand ask endpoint (`/internal/tls-check`) may issue a
 * certificate for `<slug>.<BASE_DOMAIN>`: only live tenants — never deleted
 * or suspended ones.
 */
export async function tlsCertAllowedForSlug(slug: string): Promise<boolean> {
  // Live public names only (primary or alias) — never retired or internal-only names
  const tenantId = await tenantIdForHostname(slug);
  if (!tenantId) return false;
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(eq(tenants.id, tenantId), ne(tenants.status, "deleted"), eq(tenants.suspended, false)))
    .limit(1);
  return Boolean(tenant);
}

/** Submit a join request. Requires auth but NOT membership. */
apiRouter.post(
  "/api/tenants/:id/join-requests",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "id");
    const userId = authUserId(req);
    const { message } = req.body as { message?: string };

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

    // Already a member?
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

    const safeMessage = typeof message === "string" && message ? message.slice(0, 500) : null;

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
apiRouter.get(
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

/**
 * The tenant delete path: tear down the control-plane instance (container or
 * coordinator tenant), soft-delete the row, release its port, resync Caddy and
 * drop it as the instance default tailnet. Callers do authorization + audit.
 * Throws if the control plane refuses (the row is then left untouched).
 */
export async function deleteTenantInstance(tenant: typeof tenants.$inferSelect): Promise<void> {
  const tenantId = tenant.id;
  if (tenant.containerId) {
    await destroyInstance(tenant.containerId);
  }

  if (useCoordinator && tenant.coordinatorTenantId) {
    await getCoordinatorClient(tenant).deleteTenant();
  }

  await db
    .update(tenants)
    .set({ status: "deleted", containerId: null, updatedAt: new Date() })
    .where(eq(tenants.id, tenantId));

  // A deleted tailnet's outstanding invitations can no longer be accepted
  await db
    .update(invitations)
    .set({ status: "revoked", updatedAt: new Date() })
    .where(and(eq(invitations.tenantId, tenantId), eq(invitations.status, "pending")))
    .catch((err: unknown) => logger.warn({ tenantId, err }, "failed to revoke pending invitations"));

  // Give the real Headscale port back (tenants.port is UNIQUE across all rows)
  await releaseTenantPort(tenantId).catch((err) =>
    logger.warn({ tenantId, err }, "failed to release tenant port"),
  );

  await syncTenantRoutes().catch((err) =>
    logger.error({ tenantSlug: tenant.slug, err }, "failed to sync Caddy routes"),
  );

  await clearDefaultTailnetIf(tenantId).catch((err) =>
    logger.warn({ tenantId, err }, "failed to clear default tailnet"),
  );
}

apiRouter.delete("/api/tenants/:id", requireAuth, stepUpForSession, async (req, res) => {
  const tenantId = param(req, "id");
  const result = await getTenantForUser(tenantId, authUserId(req));

  if (!result) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  if (!result.membership.isOriginator) {
    res.status(403).json({ error: "Only the tenant originator can delete" });
    return;
  }
  // Destructive lifecycle action: interactive session only, never agent tokens
  if (req.agentToken) {
    res.status(403).json({ error: "Agent tokens cannot delete a tenant" });
    return;
  }

  try {
    await deleteTenantInstance(result.tenant);

    logAudit({
      tenantId,
      actorUserId: authUserId(req),
      action: "tenant_deleted",
      targetType: "tenant",
      targetId: tenantId,
    });

    res.json({ status: "deleted" });
  } catch (err) {
    logger.error({ tenantId, err }, "failed to delete tenant");
    res.status(502).json({ error: "Failed to delete tenant" });
  }
});

apiRouter.post("/api/tenants/:id/start", requireAuth, async (req, res) => {
  const result = await getTenantForUser(param(req, "id"), authUserId(req));
  if (!result) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  if (!result.membership.isOriginator) {
    res.status(403).json({ error: "Only the tenant originator can start" });
    return;
  }
  // Destructive lifecycle action: interactive session only, never agent tokens
  if (req.agentToken) {
    res.status(403).json({ error: "Agent tokens cannot start a tenant" });
    return;
  }
  if (useCoordinator) {
    res.status(501).json({ error: "Tenant lifecycle is managed by the coordinator — start/stop is not applicable" });
    return;
  }
  if (!result.tenant.containerId) {
    res.status(500).json({ error: "Tenant instance not available" });
    return;
  }

  try {
    await startInstance(result.tenant.containerId);
    await db
      .update(tenants)
      .set({ status: "running", updatedAt: new Date() })
      .where(eq(tenants.id, result.tenant.id));
    logAudit({
      tenantId: result.tenant.id,
      actorUserId: authUserId(req),
      action: "tenant_started",
      targetType: "tenant",
      targetId: result.tenant.id,
    });

    res.json({ status: "running" });
  } catch (err) {
    logger.error({ tenantId: result.tenant.id, err }, "failed to start tenant");
    res.status(502).json({ error: "Failed to start tenant" });
  }
});

apiRouter.post("/api/tenants/:id/stop", requireAuth, async (req, res) => {
  const result = await getTenantForUser(param(req, "id"), authUserId(req));
  if (!result) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  if (!result.membership.isOriginator) {
    res.status(403).json({ error: "Only the tenant originator can stop" });
    return;
  }
  // Destructive lifecycle action: interactive session only, never agent tokens
  if (req.agentToken) {
    res.status(403).json({ error: "Agent tokens cannot stop a tenant" });
    return;
  }
  if (useCoordinator) {
    res.status(501).json({ error: "Tenant lifecycle is managed by the coordinator — start/stop is not applicable" });
    return;
  }
  if (!result.tenant.containerId) {
    res.status(500).json({ error: "Tenant instance not available" });
    return;
  }

  try {
    await stopInstance(result.tenant.containerId);
    await db
      .update(tenants)
      .set({ status: "stopped", updatedAt: new Date() })
      .where(eq(tenants.id, result.tenant.id));
    logAudit({
      tenantId: result.tenant.id,
      actorUserId: authUserId(req),
      action: "tenant_stopped",
      targetType: "tenant",
      targetId: result.tenant.id,
    });

    res.json({ status: "stopped" });
  } catch (err) {
    logger.error({ tenantId: result.tenant.id, err }, "failed to stop tenant");
    res.status(502).json({ error: "Failed to stop tenant" });
  }
});

/** Live health status of a tenant's Headscale instance. Any member can check. */
apiRouter.get(
  "/api/tenants/:id/health",
  requireAuth,
  async (req, res) => {
    const result = await getTenantForUser(param(req, "id"), authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const reachable = useCoordinator
      ? Boolean(result.tenant.coordinatorTenantId)
      : Boolean(result.tenant.containerId && result.tenant.apiKey);
    if (!reachable) {
      res.json({ status: result.tenant.status, healthy: false });
      return;
    }

    try {
      const health = await checkTenantHealth(result.tenant);
      res.json({ status: result.tenant.status, healthy: health.healthy });
    } catch (err) {
      logger.error({ tenantId: result.tenant.id, err }, "tenant health check failed");
      res.json({ status: result.tenant.status, healthy: false });
    }
  },
);
