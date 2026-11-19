/**
 * @module operator/lifecycle
 * Operator actions with side effects on the control plane: suspend/unsuspend
 * a tenant and disable/enable a user. Route handlers in routes/operator.ts do
 * the guard + audit; these functions do the work.
 */

import { and, eq, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { agentTokens, memberships, tenants, users } from "../db/schema.js";
import { getControlClient, useCoordinator } from "../orchestrator/control-client.js";
import { CoordinatorApiClient } from "../orchestrator/coordinator-api.js";
import { startInstance, stopInstance } from "../orchestrator/headscale.js";
import { removeMemberCascade } from "../routes/devices.js";
import { revokeMemberAccess } from "../routes/access.js";
import { toHsUsername } from "../routes/helpers.js";
import { logAudit } from "../routes/audit.js";
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
 * Suspends or unsuspends a tenant. Control plane first, then the DB flag, so
 * a control-plane failure leaves nothing half-applied.
 *
 * - coordinator mode: `PUT /api/tenants/{id}/suspended` (the coordinator
 *   persists it, rejects the tenant's nodes and refuses new keys).
 * - Headscale mode: stop / start the tenant's container; `status` follows
 *   ("stopped" / "running") so the monitor neither probes nor restarts it.
 */
export async function setTenantSuspended(tenant: Tenant, suspended: boolean): Promise<Tenant> {
  if (tenant.status === "deleted") {
    throw new OperatorActionError("Tenant not found", 404);
  }
  let status = tenant.status;
  if (useCoordinator) {
    if (!tenant.coordinatorTenantId) {
      throw new OperatorActionError("Tenant is not provisioned on the coordinator yet", 409);
    }
    const client = getControlClient(tenant);
    if (client instanceof CoordinatorApiClient) {
      await client.setSuspended(suspended);
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
    .set({ suspended, status, updatedAt: new Date() })
    .where(eq(tenants.id, tenant.id))
    .returning();
  return updated;
}

/** Result of {@link disableUser}. */
export interface DisableUserResult {
  removedFrom: Array<{ tenantId: string; devicesDeleted: number; keysRevoked: number }>;
  /** Tenants the user originated: membership kept (originators can't be removed), access revoked. */
  ownedTenants: Array<{ tenantId: string; devicesDeleted: number; keysRevoked: number }>;
  agentTokensRevoked: number;
}

/**
 * Disables a user: marks them disabled (sign-in and every credential refused
 * from now on), revokes their agent tokens, and runs the kick cascade for
 * every membership. Tenants they originate keep the originator membership
 * (it can never be deleted) but their devices and keys are still removed —
 * the operator can suspend or delete such tenants separately.
 */
export async function disableUser(targetUserId: string, actorUserId: string): Promise<DisableUserResult> {
  await db
    .update(users)
    .set({ disabledAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, targetUserId));

  const revokedTokens = await db
    .update(agentTokens)
    .set({ status: "revoked" })
    .where(and(eq(agentTokens.userId, targetUserId), eq(agentTokens.status, "active")))
    .returning({ id: agentTokens.id });

  const rows = await db
    .select({ tenant: tenants, isOriginator: memberships.isOriginator })
    .from(memberships)
    .innerJoin(tenants, eq(memberships.tenantId, tenants.id))
    .where(and(eq(memberships.userId, targetUserId), ne(tenants.status, "deleted")));

  const out: DisableUserResult = {
    removedFrom: [],
    ownedTenants: [],
    agentTokensRevoked: revokedTokens.length,
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
