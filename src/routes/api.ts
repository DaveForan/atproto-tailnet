import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, tenants, memberships, invitations } from "../db/schema.js";
import { requireAuth, param } from "./helpers.js";

export const apiRouter = Router();

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
      port: tenants.port,
    })
    .from(memberships)
    .innerJoin(tenants, eq(memberships.tenantId, tenants.id))
    .where(eq(memberships.userId, req.session.userId!));

  res.json(userTenants);
});

apiRouter.get("/api/tenants/:id", requireAuth, async (req, res) => {
  const [membership] = await db
    .select()
    .from(memberships)
    .where(eq(memberships.tenantId, param(req, "id")))
    .innerJoin(tenants, eq(memberships.tenantId, tenants.id));

  if (!membership || membership.memberships.userId !== req.session.userId) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  res.json({
    id: membership.tenants.id,
    slug: membership.tenants.slug,
    name: membership.tenants.name,
    status: membership.tenants.status,
    port: membership.tenants.port,
    role: membership.memberships.role,
    loginServer: `http://localhost:${membership.tenants.port}`,
  });
});

apiRouter.get("/api/tenants/:id/invitations", requireAuth, async (req, res) => {
  const tenantInvitations = await db
    .select()
    .from(invitations)
    .where(eq(invitations.tenantId, param(req, "id")));

  res.json(tenantInvitations);
});
