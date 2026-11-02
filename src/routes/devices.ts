/**
 * @module routes/devices
 * Device and member management: list Headscale nodes grouped by user,
 * generate pre-auth keys (with optional device-approval flow), remove
 * individual nodes, list members, and kick members (cascading cleanup
 * of devices, services, board posts, and approvals).
 */

import { Router } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  memberships,
  roles,
  users,
  deviceApprovals,
  deviceLocks,
  serviceDevices,
  services,
  boardPosts,
} from "../db/schema.js";
import { HeadscaleApiClient } from "../orchestrator/headscale-api.js";
import {
  requireAuth,
  param,
  getTenantForUser,
  hasPermission,
  isLockedDown,
  toHsUsername,
  tenantLoginServer,
  authUserId,
} from "./helpers.js";
import { logAudit } from "./audit.js";
import { logger } from "../logger.js";

/**
 * Router for device listing, auth-key generation, node removal,
 * member listing, and member removal with cascading cleanup.
 */
export const devicesRouter = Router();

devicesRouter.get(
  "/api/tenants/:tenantId/devices",
  requireAuth,
  async (req, res) => {
    const result = await getTenantForUser(
      param(req, "tenantId"),
      authUserId(req),
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

      const grouped = new Map<
        string,
        { hsUsername: string; devices: typeof mapped }
      >();

      const mapped = nodes.map((n) => ({
        id: n.id,
        name: n.givenName || n.name,
        ipAddresses: n.ipAddresses ?? [],
        online: n.online ?? false,
        lastSeen: n.lastSeen,
        machineKey: n.machineKey ?? null,
        user: n.user?.name ?? "unknown",
      }));

      for (const d of mapped) {
        if (!grouped.has(d.user)) {
          grouped.set(d.user, { hsUsername: d.user, devices: [] });
        }
        grouped.get(d.user)!.devices.push(d);
      }

      res.json({
        byUser: Array.from(grouped.values()),
        total: nodes.length,
      });
    } catch (err) {
      logger.error({ err }, "failed to list devices");
      res.status(502).json({ error: "Failed to reach Headscale instance" });
    }
  },
);

devicesRouter.post(
  "/api/tenants/:tenantId/devices/auth-key",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!result.tenant.apiKey) {
      res.status(500).json({ error: "Tenant instance not available" });
      return;
    }

    if (isLockedDown(result.tenant)) {
      res.status(403).json({ error: "Tenant is in lockdown mode" });
      return;
    }

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, authUserId(req)));

    const hsUsername =
      result.membership.isOriginator
        ? "owner"
        : toHsUsername(user.handle);

    const locks = await db
      .select()
      .from(deviceLocks)
      .where(eq(deviceLocks.membershipId, result.membership.id))
      .limit(1);

    if (locks.length > 0) {
      res.status(403).json({
        error: "Session is locked to specific devices. Remove lock to add new devices.",
      });
      return;
    }

    if (result.tenant.requireDeviceApproval && !result.membership.isOriginator) {
      const [approval] = await db
        .insert(deviceApprovals)
        .values({
          tenantId,
          requesterId: authUserId(req),
          hsUsername,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        })
        .returning();

      logAudit({
        tenantId,
        actorUserId: authUserId(req),
        action: "device_approval_requested",
        targetType: "device_approval",
        targetId: approval.id,
      });

      res.status(202).json({
        approvalId: approval.id,
        status: "pending_approval",
      });
      return;
    }

    try {
      const client = new HeadscaleApiClient(
        result.tenant.port,
        result.tenant.apiKey,
      );
      const authKey = await client.createPreAuthKey(hsUsername);
      const loginServer = tenantLoginServer(result.tenant.slug);

      logAudit({
        tenantId,
        actorUserId: authUserId(req),
        action: "device_auth_key_created",
        targetType: "device",
      });

      res.json({
        key: authKey.key,
        command: `tailscale up --login-server ${loginServer} --authkey ${authKey.key}`,
        loginServer,
      });
    } catch (err) {
      logger.error({ err }, "failed to create pre-auth key");
      res.status(502).json({ error: "Failed to create auth key" });
    }
  },
);

devicesRouter.delete(
  "/api/tenants/:tenantId/devices/:nodeId",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const nodeId = param(req, "nodeId");

    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const client = new HeadscaleApiClient(
      result.tenant.port,
      result.tenant.apiKey,
    );

    if (!hasPermission(result.membership, result.role, "manage_devices", req)) {
      try {
        const node = await client.getNode(nodeId);
        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.id, authUserId(req)));
        const expectedHsUser = result.membership.isOriginator
          ? "owner"
          : toHsUsername(user.handle);
        if (node.user?.name !== expectedHsUser) {
          res.status(403).json({ error: "Can only remove your own devices" });
          return;
        }
      } catch {
        res.status(502).json({ error: "Failed to verify device ownership" });
        return;
      }
    }

    try {
      await client.deleteNode(nodeId);

      logAudit({
        tenantId,
        actorUserId: authUserId(req),
        action: "device_removed",
        targetType: "device",
        targetId: nodeId,
      });

      res.json({ status: "deleted" });
    } catch (err) {
      logger.error({ err }, "failed to delete device");
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
      authUserId(req),
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
        isOriginator: memberships.isOriginator,
        roleId: memberships.roleId,
        roleName: roles.name,
        joinedAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .leftJoin(roles, eq(memberships.roleId, roles.id))
      .where(eq(memberships.tenantId, param(req, "tenantId")))
      .orderBy(desc(memberships.createdAt))
      .limit(200);

    res.json(members);
  },
);

devicesRouter.delete(
  "/api/tenants/:tenantId/members/:userId",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const removedUserId = param(req, "userId");

    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "kick", req)) {
      res.status(403).json({ error: "You do not have permission to remove members" });
      return;
    }

    if (removedUserId === authUserId(req)) {
      res.status(400).json({ error: "Cannot remove yourself" });
      return;
    }

    const [targetMembership] = await db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          eq(memberships.userId, removedUserId),
        ),
      );

    if (!targetMembership) {
      res.status(404).json({ error: "Member not found" });
      return;
    }

    if (targetMembership.isOriginator) {
      res.status(403).json({ error: "Cannot remove the tenant originator" });
      return;
    }

    const [removedUser] = await db
      .select()
      .from(users)
      .where(eq(users.id, removedUserId));

    if (removedUser && result.tenant.apiKey) {
      const hsUsername = toHsUsername(removedUser.handle);

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
        logger.error({ err, hsUsername }, "failed to clean up Headscale for user");
      }
    }

    await db
      .update(deviceApprovals)
      .set({ status: "rejected", reviewedAt: new Date() })
      .where(
        and(
          eq(deviceApprovals.tenantId, tenantId),
          eq(deviceApprovals.requesterId, removedUserId),
          eq(deviceApprovals.status, "pending"),
        ),
      );

    // Soft-delete board posts by this user
    await db
      .update(boardPosts)
      .set({ status: "removed", updatedAt: new Date() })
      .where(
        and(
          eq(boardPosts.tenantId, tenantId),
          eq(boardPosts.authorId, removedUserId),
          eq(boardPosts.status, "active"),
        ),
      );

    // Remove services owned by this user (board posts already cleaned above)
    const userServices = await db
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.tenantId, tenantId), eq(services.ownerId, removedUserId)));
    for (const svc of userServices) {
      await db
        .update(boardPosts)
        .set({ status: "removed", updatedAt: new Date() })
        .where(and(eq(boardPosts.serviceId, svc.id), eq(boardPosts.status, "active")));
      await db.delete(services).where(eq(services.id, svc.id));
    }

    // Remove service devices owned by this user
    await db
      .delete(serviceDevices)
      .where(and(eq(serviceDevices.tenantId, tenantId), eq(serviceDevices.ownerId, removedUserId)));

    await db
      .delete(memberships)
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          eq(memberships.userId, removedUserId),
        ),
      );

    logAudit({
      tenantId,
      actorUserId: authUserId(req),
      action: "member_removed",
      targetType: "member",
      targetId: removedUserId,
      metadata: removedUser
        ? { handle: removedUser.handle }
        : undefined,
    });

    res.json({ status: "removed" });
  },
);
