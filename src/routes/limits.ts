/**
 * @module routes/limits
 * Admin-set caps (replacing the old fake "plans"): maxDevices / maxMembers,
 * 0 = unlimited. Enforced at auth-key issuance, device-approval approval,
 * invitation acceptance and join-request approval.
 */

import type { Response } from "express";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { memberships, tenants } from "../db/schema.js";
import type { ControlClient } from "../orchestrator/control-client.js";
import { notify } from "../notifications/service.js";
import { logger } from "../logger.js";

export const MAX_LIMIT = 10_000;

/** True when a cap is set (> 0) and `count` has reached it. */
export function isAtCapacity(count: number, max: number): boolean {
  return max > 0 && count >= max;
}

/** True when a cap is set and `count` is over it (usage `overLimit`). */
export function isOverLimit(count: number, max: number): boolean {
  return max > 0 && count > max;
}

/**
 * A sub-collective's cap must fit inside its parent's. Parent 0 = unlimited
 * (anything goes); under a capped parent the child may not be 0 (unlimited)
 * nor exceed the parent.
 *
 * @returns an error message, or null when acceptable.
 */
export function checkChildLimit(
  name: "device" | "member",
  child: number,
  parent: number | null | undefined,
): string | null {
  if (parent === null || parent === undefined || parent === 0) return null;
  if (child === 0) return `A sub-collective of a capped parent cannot have an unlimited ${name} limit (parent: ${parent})`;
  if (child > parent) return `Cannot exceed the parent's ${name} limit (${parent})`;
  return null;
}

/** Number of members in a tenant. */
export async function countMembers(tenantId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(memberships)
    .where(eq(memberships.tenantId, tenantId));
  return row?.count ?? 0;
}

/**
 * Enforce maxDevices before a new pre-auth key is minted. Sends the 403
 * (`code: "device_limit"`) / 502 response itself and raises a (deduplicated)
 * device_limit_reached notification; returns false when the caller must stop.
 */
export async function enforceDeviceLimit(
  res: Response,
  tenant: typeof tenants.$inferSelect,
  client: ControlClient,
): Promise<boolean> {
  if (tenant.maxDevices <= 0) return true;
  let count: number;
  try {
    count = (await client.listNodes()).length;
  } catch (err) {
    logger.error({ tenantId: tenant.id, err }, "failed to count devices for limit check");
    res.status(502).json({ error: "Failed to verify the device limit" });
    return false;
  }
  if (!isAtCapacity(count, tenant.maxDevices)) return true;

  notify(
    tenant.id,
    "device_limit_reached",
    {
      title: "Device limit reached",
      body: `${tenant.name} has ${count} of ${tenant.maxDevices} devices — a new device was refused. Remove devices or raise the limit.`,
      link: "/#usage",
    },
    { dedupeWindowMs: 60 * 60 * 1000 },
  );
  res.status(403).json({
    error: `Device limit reached (${tenant.maxDevices})`,
    code: "device_limit",
  });
  return false;
}

/**
 * Enforce maxMembers before adding a member. Sends 403 (`code: "member_limit"`)
 * and returns false when full.
 */
export async function enforceMemberLimit(
  res: Response,
  tenant: typeof tenants.$inferSelect,
): Promise<boolean> {
  if (tenant.maxMembers <= 0) return true;
  const count = await countMembers(tenant.id);
  if (!isAtCapacity(count, tenant.maxMembers)) return true;
  res.status(403).json({
    error: `Member limit reached (${tenant.maxMembers})`,
    code: "member_limit",
  });
  return false;
}
