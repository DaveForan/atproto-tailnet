/**
 * @module operator/lifecycle
 * Operator actions with control-plane side effects: tenant suspension and user disablement.
 * Route handlers in routes/operator.ts do the guard and the audit.
 */

import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { agentTokens, invitations, joinRequests, memberships, tenants, users } from "../db/schema.js";
import { oauthProvider } from "../oauth/index.js";
import { getControlClient, getCoordinatorClient, useCoordinator } from "../orchestrator/control-client.js";
import { startInstance, stopInstance } from "../orchestrator/headscale.js";
import { removeMemberCascade } from "../members/cascade.js";
import { revokeMemberAccess } from "../access/keys.js";
import { toHsUsername } from "../identity/handles.js";
import { logAudit } from "../audit/log.js";
import { logger } from "../logger.js";

type Tenant = typeof tenants.$inferSelect;

/** Thrown when the action cannot be applied in the tenant's current state. */
export class OperatorActionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

/**
 * Suspends or unsuspends one tenant: control plane first, then the DB flag, so a failure leaves nothing half-applied.
 * - Coordinator mode: the coordinator rejects the tenant's nodes and refuses new keys.
 * - Headscale mode: the container stops or starts; `status` follows, so the monitor leaves it alone.
 * `suspendedByParentId` records a cascade (see {@link setTenantSuspendedCascade}).
 * `lenient` (cascade only): a tenant not yet on the coordinator has no nodes, so only the DB flag changes.
 */
export async function setTenantSuspended(
  tenant: Tenant,
  suspended: boolean,
  opts: { suspendedByParentId?: string | null; lenient?: boolean } = {},
): Promise<Tenant> {
  if (tenant.status === "deleted") {
    throw new OperatorActionError("Tenant not found", 404);
  }
  let status = tenant.status;
  if (useCoordinator) {
    if (tenant.coordinatorTenantId) {
      await getCoordinatorClient(tenant).setSuspended(suspended);
    } else if (!opts.lenient) {
      throw new OperatorActionError("Tenant is not provisioned on the coordinator yet", 409);
    }
  } else if (tenant.containerId) {
    if (suspended) {
      await stopInstance(tenant.containerId);
      status = "stopped";
    } else {
      await startInstance(tenant.containerId);
      status = "running";
    }
  }

  const [updated] = await db
    .update(tenants)
    .set({
      suspended,
      suspendedByParentId: suspended ? (opts.suspendedByParentId ?? null) : null,
      status,
      updatedAt: new Date(),
    })
    .where(eq(tenants.id, tenant.id))
    .returning();
  return updated;
}

/** Every non-deleted descendant of `rootId` (breadth-first, bounded depth). */
export async function listDescendants(rootId: string): Promise<Tenant[]> {
  const out: Tenant[] = [];
  const seen = new Set<string>([rootId]);
  let frontier = [rootId];
  for (let depth = 0; depth < 32 && frontier.length > 0; depth++) {
    const children = await db
      .select()
      .from(tenants)
      .where(and(inArray(tenants.parentId, frontier), ne(tenants.status, "deleted")));
    frontier = [];
    for (const c of children) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
      frontier.push(c.id);
    }
  }
  return out;
}

/** Result of {@link setTenantSuspendedCascade}. */
export interface SuspensionCascadeResult {
  tenant: Tenant;
  /** Descendants suspended (or restored) by this call. */
  cascaded: string[];
  /** Descendants whose control-plane call failed (left unchanged; retry the action). */
  failed: Array<{ tenantId: string; error: string }>;
}

/**
 * Suspends a tenant and every descendant not already suspended, or reverses that cascade.
 * Unsuspend restores only the descendants this suspension reached; independently suspended ones stay.
 * Idempotent: a repeated suspend retries failed descendants.
 * A tenant with a suspended parent cannot be unsuspended alone (409 `parent_suspended`).
 */
export async function setTenantSuspendedCascade(
  tenant: Tenant,
  suspended: boolean,
): Promise<SuspensionCascadeResult> {
  const result: SuspensionCascadeResult = { tenant, cascaded: [], failed: [] };
  const record = async (t: Tenant, fn: () => Promise<unknown>) => {
    try {
      await fn();
      result.cascaded.push(t.id);
    } catch (err) {
      logger.error({ tenantId: t.id, rootId: tenant.id, err }, "suspension cascade failed for tenant");
      result.failed.push({ tenantId: t.id, error: err instanceof Error ? err.message : String(err) });
    }
  };

  if (suspended) {
    if (!tenant.suspended) {
      result.tenant = await setTenantSuspended(tenant, true, { suspendedByParentId: null });
    } else if (tenant.suspendedByParentId) {
      // Was suspended only by a cascade: the operator now suspends it explicitly.
      const [updated] = await db
        .update(tenants)
        .set({ suspendedByParentId: null, updatedAt: new Date() })
        .where(eq(tenants.id, tenant.id))
        .returning();
      result.tenant = updated ?? tenant;
    }
    for (const d of await listDescendants(tenant.id)) {
      if (d.suspended) continue;
      await record(d, () => setTenantSuspended(d, true, { suspendedByParentId: tenant.id, lenient: true }));
    }
    return result;
  }

  if (tenant.parentId) {
    const [parent] = await db
      .select({ suspended: tenants.suspended })
      .from(tenants)
      .where(eq(tenants.id, tenant.parentId));
    if (parent?.suspended) {
      throw new OperatorActionError(
        "Its parent tailnet is suspended; unsuspend the parent instead",
        409,
        "parent_suspended",
      );
    }
  }
  if (tenant.suspended) {
    result.tenant = await setTenantSuspended(tenant, false);
  }
  const restore = await db
    .select()
    .from(tenants)
    .where(and(eq(tenants.suspendedByParentId, tenant.id), ne(tenants.status, "deleted")));
  for (const d of restore) {
    await record(d, () => setTenantSuspended(d, false, { lenient: true }));
  }
  return result;
}

/** Result of {@link disableUser}. */
export interface DisableUserResult {
  removedFrom: Array<{ tenantId: string; devicesDeleted: number; keysRevoked: number }>;
  /** Tenants the user originated: membership kept (originators can't be removed), access revoked. */
  ownedTenants: Array<{ tenantId: string; devicesDeleted: number; keysRevoked: number }>;
  agentTokensRevoked: number;
  mcpGrantsRevoked: number;
  /** Their pending join requests, now `rejected`. */
  joinRequestsCancelled: number;
  /** Pending invitations addressed to their DID, now `revoked`. */
  invitationsRevoked: number;
}

/**
 * Disables a user, revokes their agent tokens, and kicks them from every membership.
 * Originator memberships cannot be deleted, so they stay, but their devices and keys go.
 */
export async function disableUser(targetUserId: string, actorUserId: string): Promise<DisableUserResult> {
  const now = new Date();
  const [disabled] = await db
    .update(users)
    .set({ disabledAt: now, updatedAt: now })
    .where(eq(users.id, targetUserId))
    .returning({ did: users.did });

  const revokedTokens = await db
    .update(agentTokens)
    .set({ status: "revoked" })
    .where(and(eq(agentTokens.userId, targetUserId), eq(agentTokens.status, "active")))
    .returning({ id: agentTokens.id });

  // MCP connections: revoked outright (enable must not bring them back).
  const revokedGrants = await oauthProvider.store.revokeAllGrantsForUser(targetUserId);
  for (const grantId of revokedGrants) {
    oauthProvider.store.audit({
      actorUserId,
      action: "mcp_grant_revoked",
      grantId,
      metadata: { userId: targetUserId, reason: "user_disabled_by_operator" },
    });
  }

  const cancelledJoins = await db
    .update(joinRequests)
    .set({ status: "rejected", reviewedById: actorUserId, reviewedAt: now })
    .where(and(eq(joinRequests.requesterId, targetUserId), eq(joinRequests.status, "pending")))
    .returning({ id: joinRequests.id, tenantId: joinRequests.tenantId });

  const revokedInvites = disabled?.did
    ? await db
        .update(invitations)
        .set({ status: "revoked", updatedAt: now })
        .where(and(eq(invitations.inviteeDid, disabled.did), eq(invitations.status, "pending")))
        .returning({ id: invitations.id, tenantId: invitations.tenantId })
    : [];
  for (const j of cancelledJoins) {
    logAudit({
      tenantId: j.tenantId,
      actorUserId,
      action: "join_request_rejected",
      targetType: "join_request",
      targetId: j.id,
      metadata: { reason: "user_disabled_by_operator" },
    });
  }
  for (const inv of revokedInvites) {
    logAudit({
      tenantId: inv.tenantId,
      actorUserId,
      action: "invitation_revoked",
      targetType: "invitation",
      targetId: inv.id,
      metadata: { reason: "user_disabled_by_operator" },
    });
  }

  const rows = await db
    .select({ tenant: tenants, isOriginator: memberships.isOriginator })
    .from(memberships)
    .innerJoin(tenants, eq(memberships.tenantId, tenants.id))
    .where(and(eq(memberships.userId, targetUserId), ne(tenants.status, "deleted")));

  const out: DisableUserResult = {
    removedFrom: [],
    ownedTenants: [],
    agentTokensRevoked: revokedTokens.length,
    mcpGrantsRevoked: revokedGrants.length,
    joinRequestsCancelled: cancelledJoins.length,
    invitationsRevoked: revokedInvites.length,
  };

  for (const { tenant, isOriginator } of rows) {
    try {
      if (isOriginator) {
        const [user] = await db.select().from(users).where(eq(users.id, targetUserId));
        let client: ReturnType<typeof getControlClient> | null = null;
        try {
          if (tenant.apiKey || useCoordinator) client = getControlClient(tenant);
        } catch (err) {
          logger.error({ tenantId: tenant.id, err }, "no control client for disable cleanup");
        }
        const access = await revokeMemberAccess({
          tenantId: tenant.id,
          client,
          userId: targetUserId,
          hsUsername: toHsUsername(user?.handle ?? ""),
        });
        out.ownedTenants.push({
          tenantId: tenant.id,
          devicesDeleted: access.devicesDeleted,
          keysRevoked: access.keysRevoked,
        });
        continue;
      }

      const { removedUser, access } = await removeMemberCascade(tenant, targetUserId);
      const entry = {
        tenantId: tenant.id,
        devicesDeleted: access?.devicesDeleted ?? 0,
        keysRevoked: access?.keysRevoked ?? 0,
      };
      out.removedFrom.push(entry);
      logAudit({
        tenantId: tenant.id,
        actorUserId,
        action: "member_removed",
        targetType: "member",
        targetId: targetUserId,
        metadata: {
          handle: removedUser?.handle,
          reason: "user_disabled_by_operator",
          devicesDeleted: entry.devicesDeleted,
          keysRevoked: entry.keysRevoked,
          ...(access?.errors.length ? { cleanupErrors: access.errors } : {}),
        },
      });
    } catch (err) {
      logger.error({ tenantId: tenant.id, userId: targetUserId, err }, "disable cascade failed for tenant");
    }
  }
  return out;
}

/** Re-enables a disabled user. Memberships removed on disable are not restored. */
export async function enableUser(targetUserId: string): Promise<void> {
  await db
    .update(users)
    .set({ disabledAt: null, updatedAt: new Date() })
    .where(eq(users.id, targetUserId));
}
