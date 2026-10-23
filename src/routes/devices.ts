import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants, memberships, users } from "../db/schema.js";
import { HeadscaleApiClient } from "../orchestrator/headscale-api.js";
import { createPreAuthKeyInInstance } from "../orchestrator/headscale.js";
import { requireAuth, param } from "./helpers.js";

export const devicesRouter = Router();

async function getTenantForUser(
  tenantId: string,
  userId: string,
): Promise<
  | {
      tenant: typeof tenants.$inferSelect;
      membership: typeof memberships.$inferSelect;
    }
  | null
> {
  const results = await db
    .select({ tenant: tenants, membership: memberships })
    .from(memberships)
    .innerJoin(tenants, eq(memberships.tenantId, tenants.id))
    .where(
      and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)),
    );

  return results[0] ?? null;
}

// List devices in a tenant
devicesRouter.get("/api/tenants/:tenantId/devices", requireAuth, async (req, res) => {
  const result = await getTenantForUser(
    param(req, "tenantId"),
    req.session.userId!,
  );
  if (!result) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  const client = new HeadscaleApiClient(
    result.tenant.port,
    result.tenant.apiKey,
  );

  try {
    const nodes = await client.listNodes();
    res.json(
      nodes.map((n) => ({
        id: n.id,
        name: n.givenName || n.name,
        ipAddresses: n.ipAddresses,
        online: n.online,
        lastSeen: n.lastSeen,
        user: n.user?.name,
      })),
    );
  } catch (err) {
    console.error("Failed to list devices:", err);
    res.status(502).json({ error: "Failed to reach Headscale instance" });
  }
});

// Generate pre-auth key for adding a device
devicesRouter.post(
  "/api/tenants/:tenantId/devices/auth-key",
  requireAuth,
  async (req, res) => {
    const result = await getTenantForUser(
      param(req, "tenantId"),
      req.session.userId!,
    );
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!result.tenant.containerId) {
      res.status(500).json({ error: "Tenant instance not available" });
      return;
    }

    // Determine the Headscale username for this user
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, req.session.userId!));

    const hsUsername =
      result.membership.role === "owner"
        ? "owner"
        : user.handle
            .replace(/[^a-z0-9]+/gi, "-")
            .replace(/^-|-$/g, "")
            .toLowerCase();

    try {
      const key = await createPreAuthKeyInInstance(
        result.tenant.containerId,
        hsUsername,
      );

      const loginServer = `http://localhost:${result.tenant.port}`;

      res.json({
        key,
        command: `tailscale up --login-server ${loginServer} --authkey ${key}`,
        loginServer,
      });
    } catch (err) {
      console.error("Failed to create pre-auth key:", err);
      res.status(502).json({ error: "Failed to create auth key" });
    }
  },
);

// Delete a device
devicesRouter.delete(
  "/api/tenants/:tenantId/devices/:nodeId",
  requireAuth,
  async (req, res) => {
    const result = await getTenantForUser(
      param(req, "tenantId"),
      req.session.userId!,
    );
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    // Only owners can delete any device; members can only delete their own
    // (simplified: owner-only for now)
    if (result.membership.role !== "owner") {
      res.status(403).json({ error: "Only the tenant owner can remove devices" });
      return;
    }

    const client = new HeadscaleApiClient(
      result.tenant.port,
      result.tenant.apiKey,
    );

    try {
      await client.deleteNode(param(req, "nodeId"));
      res.json({ status: "deleted" });
    } catch (err) {
      console.error("Failed to delete device:", err);
      res.status(502).json({ error: "Failed to delete device" });
    }
  },
);

// List members of a tenant
devicesRouter.get("/api/tenants/:tenantId/members", requireAuth, async (req, res) => {
  const result = await getTenantForUser(
    param(req, "tenantId"),
    req.session.userId!,
  );
  if (!result) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  const members = await db
    .select({
      id: users.id,
      handle: users.handle,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      role: memberships.role,
      joinedAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.tenantId, param(req, "tenantId")));

  res.json(members);
});

// Remove member (owner only)
devicesRouter.delete(
  "/api/tenants/:tenantId/members/:userId",
  requireAuth,
  async (req, res) => {
    const result = await getTenantForUser(
      param(req, "tenantId"),
      req.session.userId!,
    );
    if (!result || result.membership.role !== "owner") {
      res.status(403).json({ error: "Only the tenant owner can remove members" });
      return;
    }

    if (param(req, "userId") === req.session.userId) {
      res.status(400).json({ error: "Cannot remove yourself" });
      return;
    }

    await db
      .delete(memberships)
      .where(
        and(
          eq(memberships.tenantId, param(req, "tenantId")),
          eq(memberships.userId, param(req, "userId")),
        ),
      );

    res.json({ status: "removed" });
  },
);
