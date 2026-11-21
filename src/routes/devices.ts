/**
 * @module routes/devices
 * Devices and members: list nodes, issue pre-auth keys (optional approval), remove nodes, kick members.
 */

import { Router } from "express";
import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  memberships,
  roles,
  users,
  deviceApprovals,
  authKeys,
} from "../db/schema.js";
import { getControlClient, useCoordinator } from "../orchestrator/control-client.js";
import {
  requireAuth,
  param,
  hasPermission,
  toHsUsername,
  authUserId,
  permissionsAbove,
  rolePermissions,
} from "./helpers.js";
import { tenantGuard, tenantCtx } from "./guard.js";
import { logAudit } from "../audit/log.js";
import { removeMemberCascade } from "../members/cascade.js";
import { stepUpForSession } from "../auth/step-up.js";
import { logger } from "../logger.js";
import { tenantLoginServerFor } from "../orchestrator/hostnames.js";
import { notify } from "../notifications/service.js";
import { sendDeviceRefusal } from "./limits.js";
import { deviceAdmission } from "../access/admission.js";
import {
  issueMemberKey,
  revokeControlKey,
  filterVisibleKeys,
  memberKeyOptionsError,
  DEFAULT_KEY_HOURS,
  MAX_KEY_HOURS,
  type AuthKeyView,
} from "../access/keys.js";
import type { ControlPreAuthKeyInfo } from "../orchestrator/control-client.js";
import { parseBody } from "./validation.js";

export const devicesRouter = Router({ caseSensitive: true });

const authKeyBody = z.object({
  reusable: z.boolean().optional(),
  expiresInHours: z.number().int().min(1).max(MAX_KEY_HOURS).optional(),
});

devicesRouter.get(
  "/api/tenants/:tenantId/devices",
  requireAuth,
  tenantGuard(),
  async (req, res) => {
    const result = tenantCtx(res);

    const client = getControlClient(result.tenant);

    try {
      const nodes = await client.listNodes();

      const grouped = new Map<
        string,
        { hsUsername: string; devices: typeof mapped }
      >();

      const memberRows = await db
        .select({
          userId: users.id,
          handle: users.handle,
          isOriginator: memberships.isOriginator,
        })
        .from(memberships)
        .innerJoin(users, eq(memberships.userId, users.id))
        .where(eq(memberships.tenantId, result.tenant.id));
      const byId = new Map(memberRows.map((m) => [m.userId, m]));
      const byHsName = new Map(
        memberRows.map((m) => [m.isOriginator ? "owner" : toHsUsername(m.handle), m]),
      );

      const mapped = nodes.map((n) => {
        // Coordinator nodes carry our user id as owner; Headscale nodes a Headscale user name
        const member = n.user?.name
          ? (useCoordinator ? byId.get(n.user.name) : byHsName.get(n.user.name))
          : undefined;
        const owner = member ? { userId: member.userId, handle: member.handle } : null;
        const userLabel = useCoordinator
          ? (member ? (member.isOriginator ? "owner" : toHsUsername(member.handle)) : "unassigned")
          : (n.user?.name ?? "unknown");
        return {
          id: n.id,
          name: n.givenName || n.name,
          ipAddresses: n.ipAddresses ?? [],
          online: n.online ?? false,
          lastSeen: n.lastSeen,
          machineKey: n.machineKey ?? null,
          user: userLabel,
          owner,
        };
      });

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
  stepUpForSession,
  tenantGuard(),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = tenantCtx(res);

    // Session users keep self-service key generation; an agent token minting
    // join keys must be explicitly scoped for device management.
    if (
      req.agentToken &&
      !(req.agentToken.permissions as string[]).includes("manage_devices")
    ) {
      res.status(403).json({ error: "Agent token scope does not include manage_devices" });
      return;
    }

    if (!result.tenant.apiKey) {
      res.status(500).json({ error: "Tenant instance not available" });
      return;
    }

    const client = getControlClient(result.tenant);
    const userId = authUserId(req);
    const refusal = await deviceAdmission(result.tenant, result.membership, userId, client);
    if (refusal && refusal !== "approval_required") {
      sendDeviceRefusal(res, result.tenant, refusal);
      return;
    }

    const parsedBody = parseBody(authKeyBody, req, res, { emptyAsObject: true });
    if (!parsedBody) return;

    const keyOptionsError = memberKeyOptionsError(
      parsedBody.data,
      hasPermission(result.membership, result.role, "manage_devices", req),
    );
    if (keyOptionsError) {
      res.status(403).json({ error: keyOptionsError, code: "key_options_forbidden" });
      return;
    }

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId));

    const hsUsername =
      result.membership.isOriginator
        ? "owner"
        : toHsUsername(user.handle);

    if (refusal === "approval_required") {
      const [approval] = await db
        .insert(deviceApprovals)
        .values({
          tenantId,
          requesterId: userId,
          hsUsername,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        })
        .returning();

      logAudit({
        tenantId,
        actorUserId: userId,
        action: "device_approval_requested",
        targetType: "device_approval",
        targetId: approval.id,
      });

      notify(tenantId, "device_approval_requested", {
        title: "Device approval requested",
        body: `@${user.handle} wants to add a device to ${result.tenant.name}.`,
        link: "/#security",
      });

      res.status(202).json({
        approvalId: approval.id,
        status: "pending_approval",
      });
      return;
    }

    try {
      const authKey = await issueMemberKey({
        tenant: result.tenant,
        client,
        userId,
        hsUsername,
        reusable: parsedBody.data.reusable,
        expiresInHours: parsedBody.data.expiresInHours,
      });
      const loginServer = await tenantLoginServerFor(result.tenant);

      logAudit({
        tenantId,
        actorUserId: userId,
        action: "device_auth_key_created",
        targetType: "device",
        targetId: authKey.recordId ?? undefined,
        metadata: {
          reusable: parsedBody.data.reusable ?? false,
          expiresInHours: parsedBody.data.expiresInHours ?? DEFAULT_KEY_HOURS,
        },
      });

      res.json({
        key: authKey.key,
        command: `tailscale up --login-server ${loginServer} --authkey ${authKey.key}`,
        loginServer,
        keyId: authKey.recordId,
        expiresAt: authKey.expiration ?? null,
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
  tenantGuard(),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const nodeId = param(req, "nodeId");
    const result = tenantCtx(res);

    const client = getControlClient(result.tenant);

    if (!hasPermission(result.membership, result.role, "manage_devices", req)) {
      try {
        const node = await client.getNode(nodeId);
        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.id, authUserId(req)));
        // Coordinator nodes are owned by our user id; Headscale nodes by a Headscale user
        const expectedOwner = useCoordinator
          ? authUserId(req)
          : result.membership.isOriginator
            ? "owner"
            : toHsUsername(user.handle);
        if (!node.user?.name || node.user.name !== expectedOwner) {
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


/** Untracked control-plane keys (relay keys, keys from before tracking) use this id prefix. */
const CONTROL_KEY_PREFIX = "cp:";

devicesRouter.get(
  "/api/tenants/:tenantId/auth-keys",
  requireAuth,
  tenantGuard(),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const userId = authUserId(req);
    const result = tenantCtx(res);
    const canManage = hasPermission(result.membership, result.role, "manage_devices", req);

    const rows = await db
      .select({
        key: authKeys,
        handle: users.handle,
      })
      .from(authKeys)
      .innerJoin(users, eq(authKeys.userId, users.id))
      .where(
        canManage
          ? eq(authKeys.tenantId, tenantId)
          : and(eq(authKeys.tenantId, tenantId), eq(authKeys.userId, userId)),
      )
      .orderBy(desc(authKeys.createdAt))
      .limit(200);

    // Live state (used / revoked / expired) from the control plane, best effort
    let live: ControlPreAuthKeyInfo[] | null = null;
    if (result.tenant.apiKey || useCoordinator) {
      try {
        live = await getControlClient(result.tenant).listPreAuthKeys();
      } catch (err) {
        logger.warn({ tenantId, err }, "failed to list control-plane keys");
      }
    }
    const liveById = new Map((live ?? []).map((k) => [k.id, k]));
    const now = Date.now();

    const keys: AuthKeyView[] = rows.map(({ key, handle }) => {
      const l = key.controlKeyId ? liveById.get(key.controlKeyId) : undefined;
      return {
        id: key.id,
        prefix: key.prefix,
        owner: { userId: key.userId, handle },
        reusable: key.reusable,
        ephemeral: key.ephemeral,
        used: l?.used ?? false,
        expiresAt: key.expiresAt ? key.expiresAt.toISOString() : null,
        createdAt: key.createdAt.toISOString(),
        revoked:
          key.revokedAt !== null ||
          (l?.revoked ?? false) ||
          (key.expiresAt !== null && key.expiresAt.getTime() <= now),
      };
    });

    if (canManage && live) {
      const tracked = new Set(rows.map((r) => r.key.controlKeyId).filter(Boolean));
      for (const k of live) {
        if (tracked.has(k.id)) continue;
        keys.push({
          id: `${CONTROL_KEY_PREFIX}${k.id}`,
          prefix: k.prefix,
          owner: null,
          reusable: k.reusable,
          ephemeral: k.ephemeral,
          used: k.used,
          expiresAt: k.expiresAt,
          createdAt: k.createdAt,
          revoked: k.revoked || (k.expiresAt !== null && new Date(k.expiresAt).getTime() <= now),
        });
      }
    }

    res.json({ keys: filterVisibleKeys(keys, { userId, canManage }) });
  },
);

devicesRouter.delete(
  "/api/tenants/:tenantId/auth-keys/:keyId",
  requireAuth,
  tenantGuard(),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const keyId = param(req, "keyId");
    const userId = authUserId(req);
    const result = tenantCtx(res);
    const canManage = hasPermission(result.membership, result.role, "manage_devices", req);

    let controlKeyId: string | null;
    let recordId: string | null = null;
    if (keyId.startsWith(CONTROL_KEY_PREFIX)) {
      if (!canManage) {
        res.status(403).json({ error: "Insufficient permissions" });
        return;
      }
      controlKeyId = keyId.slice(CONTROL_KEY_PREFIX.length);
      if (!/^[A-Za-z0-9-]{1,64}$/.test(controlKeyId)) {
        res.status(404).json({ error: "Key not found" });
        return;
      }
    } else {
      if (!/^[0-9a-f-]{36}$/i.test(keyId)) {
        res.status(404).json({ error: "Key not found" });
        return;
      }
      const [row] = await db
        .select()
        .from(authKeys)
        .where(and(eq(authKeys.id, keyId), eq(authKeys.tenantId, tenantId)));
      if (!row) {
        res.status(404).json({ error: "Key not found" });
        return;
      }
      if (row.userId !== userId && !canManage) {
        res.status(403).json({ error: "Can only revoke your own keys" });
        return;
      }
      controlKeyId = row.controlKeyId;
      recordId = row.id;
    }

    try {
      if (controlKeyId && (result.tenant.apiKey || useCoordinator)) {
        await revokeControlKey(getControlClient(result.tenant), controlKeyId);
      }
      if (recordId) {
        await db
          .update(authKeys)
          .set({ revokedAt: new Date() })
          .where(and(eq(authKeys.id, recordId), eq(authKeys.tenantId, tenantId)));
      }

      logAudit({
        tenantId,
        actorUserId: userId,
        action: "auth_key_revoked",
        targetType: "auth_key",
        targetId: keyId,
      });

      res.json({ status: "revoked" });
    } catch (err) {
      logger.error({ tenantId, keyId, err }, "failed to revoke auth key");
      res.status(502).json({ error: "Failed to revoke auth key" });
    }
  },
);

devicesRouter.get(
  "/api/tenants/:tenantId/members",
  requireAuth,
  tenantGuard(),
  async (req, res) => {

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
  tenantGuard({ permission: "kick", permissionError: "You do not have permission to remove members" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const removedUserId = param(req, "userId");
    const result = tenantCtx(res);

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

    const above = permissionsAbove(
      result.membership,
      result.role,
      await rolePermissions(tenantId, targetMembership.roleId),
      req,
    );
    if (above.length > 0) {
      res.status(403).json({ error: "Cannot remove a member with permissions you do not hold", permissions: above });
      return;
    }

    const { removedUser, access } = await removeMemberCascade(result.tenant, removedUserId);

    logAudit({
      tenantId,
      actorUserId: authUserId(req),
      action: "member_removed",
      targetType: "member",
      targetId: removedUserId,
      metadata: removedUser
        ? {
            handle: removedUser.handle,
            devicesDeleted: access?.devicesDeleted ?? 0,
            keysRevoked: access?.keysRevoked ?? 0,
            ...(access?.errors.length ? { cleanupErrors: access.errors } : {}),
          }
        : undefined,
    });

    res.json({
      status: "removed",
      devicesDeleted: access?.devicesDeleted ?? 0,
      keysRevoked: access?.keysRevoked ?? 0,
      ...(access?.errors.length ? { cleanupErrors: access.errors } : {}),
    });
  },
);
