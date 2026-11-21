/**
 * @module access/keys
 * Key issuance tracking and access revocation for both control-plane modes.
 * Coordinator: keys and nodes carry `owner = <our user id>`, so revoke-by-owner removes them.
 * Headscale: keys are expired by id from the `auth_keys` table.
 */

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { authKeys, tenants } from "../db/schema.js";
import type { ControlClient, HeadscalePreAuthKey } from "../orchestrator/control-client.js";
import { CoordinatorApiClient } from "../orchestrator/coordinator-api.js";
import { HeadscaleApiClient } from "../orchestrator/headscale-api.js";
import { logger } from "../logger.js";
import { pushTenantIdentity } from "../orchestrator/coordinator-identity.js";

export const DEFAULT_KEY_HOURS = 24;
export const MAX_KEY_HOURS = 720;
/** Longest key a member without manage_devices may mint (single-use only). */
export const MEMBER_MAX_KEY_HOURS = 24;

/**
 * Key options a member may request. Reusable or long-lived keys can enrol any
 * number of devices as that member, so only device managers (manage_devices /
 * originator) may mint them. Returns an error message, or null when allowed.
 */
export function memberKeyOptionsError(
  opts: { reusable?: boolean; expiresInHours?: number },
  canManageDevices: boolean,
): string | null {
  if (canManageDevices) return null;
  if (opts.reusable) return "Only device managers can create reusable keys";
  if ((opts.expiresInHours ?? DEFAULT_KEY_HOURS) > MEMBER_MAX_KEY_HOURS) {
    return `Keys can last at most ${MEMBER_MAX_KEY_HOURS} hours unless you can manage devices`;
  }
  return null;
}

/** Revokes every outstanding key of a tenant (lockdown), best effort per key; returns the revoked count. */
export async function revokeAllTenantKeys(
  tenantId: string,
  client: ControlClient,
): Promise<number> {
  const outstanding = await db
    .select()
    .from(authKeys)
    .where(and(eq(authKeys.tenantId, tenantId), isNull(authKeys.revokedAt)));
  let revoked = 0;
  for (const k of outstanding) {
    if (!k.controlKeyId) continue; // unknown on the control plane — leave visible
    try {
      await revokeControlKey(client, k.controlKeyId);
    } catch (err) {
      logger.error({ tenantId, keyId: k.id, err }, "lockdown key revocation failed");
      continue; // leave the row unrevoked so it stays visible
    }
    revoked++;
    await db.update(authKeys).set({ revokedAt: new Date() }).where(eq(authKeys.id, k.id));
  }
  return revoked;
}

/** Mint a pre-auth key for a member and record it in `auth_keys`. */
export async function issueMemberKey(params: {
  tenant: typeof tenants.$inferSelect;
  client: ControlClient;
  userId: string;
  hsUsername: string;
  kind?: "device" | "service_device";
  reusable?: boolean;
  ephemeral?: boolean;
  expiresInHours?: number;
}): Promise<HeadscalePreAuthKey & { recordId: string | null }> {
  const hours = params.expiresInHours ?? DEFAULT_KEY_HOURS;
  const expirationSeconds = Math.round(hours * 3600);
  const reusable = params.reusable ?? false;
  const ephemeral = params.ephemeral ?? false;

  const key = await params.client.createPreAuthKey(params.hsUsername, {
    reusable,
    ephemeral,
    expirationSeconds,
    owner: params.userId,
  });

  // So the device's first registration already shows the tailnet name and the
  // member's handle in the Tailscale app (best effort; the monitor re-pushes).
  if (params.client instanceof CoordinatorApiClient && params.tenant.coordinatorTenantId) {
    await pushTenantIdentity(params.tenant.id, params.tenant.coordinatorTenantId).catch((err) =>
      logger.warn({ tenantId: params.tenant.id, err }, "failed to push tenant identity"),
    );
  }

  let recordId: string | null = null;
  try {
    const [row] = await db
      .insert(authKeys)
      .values({
        tenantId: params.tenant.id,
        userId: params.userId,
        controlKeyId: key.id ?? null,
        prefix: key.key.slice(0, 12),
        hsUsername: params.client instanceof CoordinatorApiClient ? null : params.hsUsername,
        kind: params.kind ?? "device",
        reusable,
        ephemeral,
        expiresAt: key.expiration
          ? new Date(key.expiration)
          : new Date(Date.now() + expirationSeconds * 1000),
      })
      .returning({ id: authKeys.id });
    recordId = row?.id ?? null;
  } catch (err) {
    // The key exists either way; listing falls back to the control plane.
    logger.error({ tenantId: params.tenant.id, err }, "failed to record issued auth key");
  }
  return { ...key, recordId };
}

/** Revoke one key on the control plane (by its control-plane id). */
export async function revokeControlKey(
  client: ControlClient,
  controlKeyId: string,
): Promise<void> {
  if (client instanceof CoordinatorApiClient) {
    await client.revokePreAuthKey(controlKeyId);
  } else if (client instanceof HeadscaleApiClient) {
    await client.expirePreAuthKey(controlKeyId);
  } else {
    throw new Error("Unsupported control client");
  }
}

/** Outcome of {@link revokeMemberAccess}. */
export interface RevokeAccessResult {
  devicesDeleted: number;
  keysRevoked: number;
  errors: string[];
}

/**
 * Removes a member's devices and revokes their outstanding keys (kick).
 * Every step runs even if an earlier one fails; failures are returned, not thrown.
 */
export async function revokeMemberAccess(params: {
  tenantId: string;
  client: ControlClient | null;
  userId: string;
  hsUsername: string;
}): Promise<RevokeAccessResult> {
  const { tenantId, client, userId, hsUsername } = params;
  const out: RevokeAccessResult = { devicesDeleted: 0, keysRevoked: 0, errors: [] };
  const fail = (step: string, err: unknown) => {
    out.errors.push(step);
    logger.error({ tenantId, userId, step, err }, "revoke member access step failed");
  };

  const outstanding = await db
    .select()
    .from(authKeys)
    .where(
      and(
        eq(authKeys.tenantId, tenantId),
        eq(authKeys.userId, userId),
        isNull(authKeys.revokedAt),
      ),
    );

  if (client instanceof CoordinatorApiClient) {
    // Keys first, so nothing new can register while devices are removed
    try {
      out.keysRevoked = await client.revokePreAuthKeysByOwner(userId);
    } catch (err) {
      fail("revoke_keys", err);
    }
    try {
      out.devicesDeleted = await client.deleteNodesByOwner(userId);
    } catch (err) {
      fail("delete_devices", err);
    }
  } else if (client instanceof HeadscaleApiClient) {
    for (const k of outstanding) {
      if (!k.controlKeyId) continue;
      try {
        await client.expirePreAuthKey(k.controlKeyId);
        out.keysRevoked++;
      } catch (err) {
        fail(`expire_key:${k.id}`, err);
      }
    }
    try {
      out.devicesDeleted = await client.deleteNodesByUser(hsUsername);
    } catch (err) {
      fail("delete_devices", err);
    }
    try {
      await client.deleteUser(hsUsername);
    } catch (err) {
      fail("delete_user", err);
    }
  }

  if (outstanding.length > 0) {
    await db
      .update(authKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(authKeys.tenantId, tenantId),
          eq(authKeys.userId, userId),
          isNull(authKeys.revokedAt),
        ),
      );
  }
  return out;
}

/** One key as returned by GET /auth-keys. */
export interface AuthKeyView {
  id: string;
  prefix: string;
  owner: { userId: string; handle: string } | null;
  reusable: boolean;
  ephemeral: boolean;
  used: boolean;
  expiresAt: string | null;
  createdAt: string | null;
  revoked: boolean;
}

/** Managers (manage_devices / originator) see every key; others only their own. */
export function filterVisibleKeys(
  keys: AuthKeyView[],
  viewer: { userId: string; canManage: boolean },
): AuthKeyView[] {
  if (viewer.canManage) return keys;
  return keys.filter((k) => k.owner?.userId === viewer.userId);
}
