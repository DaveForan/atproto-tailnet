import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, tenants, memberships, invitations } from "../db/schema.js";
import {
  destroyInstance,
  startInstance,
  stopInstance,
} from "../orchestrator/headscale.js";
import { removeTenantRoute } from "../orchestrator/caddy.js";
import { requireAuth, param, getTenantForUser } from "./helpers.js";
import { config } from "../config.js";

export const apiRouter = Router();

function tenantLoginServer(slug: string): string {
  const proto = config.publicUrl.startsWith("https") ? "https" : "http";
  return `${proto}://${slug}.${config.baseDomain}`;
}

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
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(tenants, eq(memberships.tenantId, tenants.id))
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
    role: result.membership.role,
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

apiRouter.delete("/api/tenants/:id", requireAuth, async (req, res) => {
  const tenantId = param(req, "id");
  const result = await getTenantForUser(tenantId, req.session.userId!);

  if (!result || result.membership.role !== "owner") {
    res.status(403).json({ error: "Only the tenant owner can delete" });
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
  if (!result || result.membership.role !== "owner") {
    res.status(403).json({ error: "Only the tenant owner can start" });
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
  if (!result || result.membership.role !== "owner") {
    res.status(403).json({ error: "Only the tenant owner can stop" });
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
