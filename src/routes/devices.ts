import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { memberships, users } from "../db/schema.js";
import { HeadscaleApiClient } from "../orchestrator/headscale-api.js";
import { requireAuth, param, getTenantForUser } from "./helpers.js";
import { config } from "../config.js";

export const devicesRouter = Router();

function tenantLoginServer(slug: string): string {
  const proto = config.publicUrl.startsWith("https") ? "https" : "http";
  return `${proto}://${slug}.${config.baseDomain}`;
}

devicesRouter.get(
  "/api/tenants/:tenantId/devices",
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
  },
);

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

    if (!result.tenant.apiKey) {
      res.status(500).json({ error: "Tenant instance not available" });
      return;
    }

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
      const client = new HeadscaleApiClient(
        result.tenant.port,
        result.tenant.apiKey,
      );
      const authKey = await client.createPreAuthKey(hsUsername);
      const loginServer = tenantLoginServer(result.tenant.slug);

      res.json({
        key: authKey.key,
        command: `tailscale up --login-server ${loginServer} --authkey ${authKey.key}`,
        loginServer,
      });
    } catch (err) {
      console.error("Failed to create pre-auth key:", err);
      res.status(502).json({ error: "Failed to create auth key" });
    }
  },
);

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

    if (result.membership.role !== "owner") {
      res
        .status(403)
        .json({ error: "Only the tenant owner can remove devices" });
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

devicesRouter.get(
  "/api/tenants/:tenantId/members",
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
  },
);

devicesRouter.delete(
  "/api/tenants/:tenantId/members/:userId",
  requireAuth,
  async (req, res) => {
    const result = await getTenantForUser(
      param(req, "tenantId"),
      req.session.userId!,
    );
    if (!result || result.membership.role !== "owner") {
      res
        .status(403)
        .json({ error: "Only the tenant owner can remove members" });
      return;
    }

    const removedUserId = param(req, "userId");
    if (removedUserId === req.session.userId) {
      res.status(400).json({ error: "Cannot remove yourself" });
      return;
    }

    const [removedUser] = await db
      .select()
      .from(users)
      .where(eq(users.id, removedUserId));

    if (removedUser && result.tenant.apiKey) {
      const hsUsername = removedUser.handle
        .replace(/[^a-z0-9]+/gi, "-")
        .replace(/^-|-$/g, "")
        .toLowerCase();

      const client = new HeadscaleApiClient(
        result.tenant.port,
        result.tenant.apiKey,
      );

      try {
        const nodes = await client.listNodes();
        const userNodes = nodes.filter((n) => n.user?.name === hsUsername);
        for (const node of userNodes) {
          await client.deleteNode(node.id);
        }
        await client.deleteUser(hsUsername);
      } catch (err) {
        console.error(
          `Failed to clean up Headscale for user ${hsUsername}:`,
          err,
        );
      }
    }

    await db
      .delete(memberships)
      .where(
        and(
          eq(memberships.tenantId, param(req, "tenantId")),
          eq(memberships.userId, removedUserId),
        ),
      );

    res.json({ status: "removed" });
  },
);
