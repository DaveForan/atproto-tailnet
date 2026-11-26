/**
 * @module routes/limits
 * Admin-set caps maxDevices / maxMembers (0 = unlimited) and the HTTP answers
 * for refused devices and members.
 */

import type { Response } from "express";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { memberships, tenants } from "../db/schema.js";
import type { CoordinatorApiClient } from "../orchestrator/coordinator-api.js";
import { deviceLimitRefusal, isAtCapacity, type DeviceRefusal } from "../access/admission.js";
import { LOCKDOWN_ERROR } from "./guard.js";

type Tenant = typeof tenants.$inferSelect;

export const MAX_LIMIT = 10_000;

export { isAtCapacity };

/** True when a cap is set and `count` is over it (usage `overLimit`). */
export function isOverLimit(count: number, max: number): boolean {
  return max > 0 && count > max;
}

/**
 * A sub-collective's cap must fit inside its parent's cap (0 = unlimited).
 * Under a capped parent the child may not be 0 or exceed the parent.
 * @returns an error message, or null when acceptable.
 */
export function checkChildLimit(
  name: "device" | "member" | "sub-collective",
  child: number,
  parent: number | null | undefined,
): string | null {
  if (parent === null || parent === undefined || parent === 0) return null;
  if (child === 0) return `A sub-collective of a capped parent cannot have an unlimited ${name} limit (parent: ${parent})`;
  if (child > parent) return `Cannot exceed the parent's ${name} limit (${parent})`;
  return null;
}

export async function countMembers(tenantId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(memberships)
    .where(eq(memberships.tenantId, tenantId));
  return row?.count ?? 0;
}

/** Sends the response for a refused device. */
export function sendDeviceRefusal(res: Response, tenant: Tenant, refusal: DeviceRefusal): void {
  switch (refusal) {
    case "locked_down":
      res.status(403).json({ error: LOCKDOWN_ERROR });
      return;
    case "device_limit":
      res.status(403).json({ error: `Device limit reached (${tenant.maxDevices})`, code: "device_limit" });
      return;
    case "limit_unverified":
      res.status(502).json({ error: "Failed to verify the device limit" });
      return;
  }
}

/** Checks maxDevices and sends the refusal; false when the caller must stop. */
export async function enforceDeviceLimit(res: Response, tenant: Tenant, client: CoordinatorApiClient): Promise<boolean> {
  const refusal = await deviceLimitRefusal(tenant, client);
  if (refusal) sendDeviceRefusal(res, tenant, refusal);
  return !refusal;
}

/**
 * Enforce maxMembers before adding a member. Sends 403 (`code: "member_limit"`)
 * and returns false when full.
 */
export async function enforceMemberLimit(
  res: Response,
  tenant: Tenant,
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
