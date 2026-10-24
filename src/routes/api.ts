import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, tenants, memberships, roles, invitations, joinRequests } from "../db/schema.js";
import {
  destroyInstance,
  startInstance,
  stopInstance,
} from "../orchestrator/headscale.js";
import { removeTenantRoute } from "../orchestrator/caddy.js";
import { requireAuth, param, getTenantForUser, tenantLoginServer } from "./helpers.js";
import { logAudit } from "./audit.js";

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
    .where(eq(users.id, req.session.userId!));

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json({
    id: user.id,
    did: user.did,
    handle: user.handle,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
  });
});

apiRouter.get("/api/tenants", requireAuth, async (req, res) => {
  const userTenants = await db
    .select({
      id: tenants.id,
      slug: tenants.slug,
      name: tenants.name,
      status: tenants.status,
      isOriginator: memberships.isOriginator,
      roleName: roles.name,
    })
    .from(memberships)
    .innerJoin(tenants, eq(memberships.tenantId, tenants.id))
    .leftJoin(roles, eq(memberships.roleId, roles.id))
    .where(eq(memberships.userId, req.session.userId!));

  res.json(userTenants);
});

apiRouter.get("/api/tenants/:id", requireAuth, async (req, res) => {
  const result = await getTenantForUser(param(req, "id"), req.session.userId!);
  if (!result) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  res.json({
    id: result.tenant.id,
    slug: result.tenant.slug,
    name: result.tenant.name,
    status: result.tenant.status,
    isOriginator: result.membership.isOriginator,
    roleName: result.role?.name ?? null,
    roleId: result.membership.roleId,
    defaultRoleId: result.tenant.defaultRoleId,
    loginServer: tenantLoginServer(result.tenant.slug),
  });
});

apiRouter.get(
  "/api/tenants/:id/invitations",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "id");
    const result = await getTenantForUser(tenantId, req.session.userId!);
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const tenantInvitations = await db
      .select()
      .from(invitations)
      .where(eq(invitations.tenantId, tenantId));

    res.json(tenantInvitations);
  },
);

/** Public tenant info — no auth required. Only returns data if join requests are enabled. */
apiRouter.get("/api/tenants/by-slug/:slug/public", async (req, res) => {
  const slug = param(req, "slug");

  const [tenant] = await db
    .select({
      id: tenants.id,
      slug: tenants.slug,
      name: tenants.name,
      allowJoinRequests: tenants.allowJoinRequests,
      lockdownMode: tenants.lockdownMode,
    })
    .from(tenants)
    .where(eq(tenants.slug, slug));

  if (!tenant || tenant.lockdownMode) {
    res.status(404).json({ error: "Tailnet not found" });
    return;
  }

  res.json({
    id: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    joinOpen: tenant.allowJoinRequests && !tenant.lockdownMode,
  });
});

/** Submit a join request. Requires auth but NOT membership. */
apiRouter.post(
  "/api/tenants/:id/join-requests",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "id");
    const userId = req.session.userId!;
    const { message } = req.body as { message?: string };

    const [tenant] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, tenantId));

    if (!tenant) {
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

    // Already pending?
    const [pendingReq] = await db
      .select()
      .from(joinRequests)
      .where(
        and(
          eq(joinRequests.tenantId, tenantId),
          eq(joinRequests.requesterId, userId),
          eq(joinRequests.status, "pending"),
        ),
      );

    if (pendingReq) {
      res.status(409).json({ error: "You already have a pending request" });
      return;
    }

    const safeMessage = message ? message.slice(0, 500) : null;

    const [created] = await db
      .insert(joinRequests)
      .values({
        tenantId,
        requesterId: userId,
        message: safeMessage,
      })
      .returning();

    logAudit({
      tenantId,
      actorUserId: userId,
      action: "join_request_created",
      targetType: "join_request",
      targetId: created.id,
    });

    res.status(201).json({ id: created.id, status: "pending" });
  },
);

/** Check the user's own join request status for a tenant. */
apiRouter.get(
  "/api/tenants/:id/join-requests/mine",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "id");
    const userId = req.session.userId!;

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

apiRouter.delete("/api/tenants/:id", requireAuth, async (req, res) => {
  const tenantId = param(req, "id");
  const result = await getTenantForUser(tenantId, req.session.userId!);

  if (!result || !result.membership.isOriginator) {
    res.status(403).json({ error: "Only the tenant originator can delete" });
    return;
  }

  try {
    if (result.tenant.containerId) {
      await destroyInstance(result.tenant.containerId);
    }

    await removeTenantRoute(result.tenant.slug).catch((err) =>
      console.error(
        `Failed to remove Caddy route for ${result.tenant.slug}:`,
        err,
      ),
    );

    await db
      .update(tenants)
      .set({ status: "deleted", containerId: null, updatedAt: new Date() })
      .where(eq(tenants.id, tenantId));

    res.json({ status: "deleted" });
  } catch (err) {
    console.error("Failed to delete tenant:", err);
    res.status(502).json({ error: "Failed to delete tenant" });
  }
});

apiRouter.post("/api/tenants/:id/start", requireAuth, async (req, res) => {
  const result = await getTenantForUser(param(req, "id"), req.session.userId!);
  if (!result || !result.membership.isOriginator) {
    res.status(403).json({ error: "Only the tenant originator can start" });
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
    res.json({ status: "running" });
  } catch (err) {
    console.error("Failed to start tenant:", err);
    res.status(502).json({ error: "Failed to start tenant" });
  }
});

apiRouter.post("/api/tenants/:id/stop", requireAuth, async (req, res) => {
  const result = await getTenantForUser(param(req, "id"), req.session.userId!);
  if (!result || !result.membership.isOriginator) {
    res.status(403).json({ error: "Only the tenant originator can stop" });
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
    res.json({ status: "stopped" });
  } catch (err) {
    console.error("Failed to stop tenant:", err);
    res.status(502).json({ error: "Failed to stop tenant" });
  }
});
