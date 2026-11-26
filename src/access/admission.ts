/**
 * @module access/admission
 * Whether a member may ask to add a device: lockdown, device locks, the device limit,
 * and in Headscale mode the approval of a key. Routes map the refusal codes to HTTP.
 * In coordinator mode a key or sign-in never admits a device: see `access/device-holds.ts`.
 */

import { isAdmitted } from "./device-holds.js";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { deviceLocks, memberships, tenants } from "../db/schema.js";
import { getControlClient, useCoordinator, type ControlClient } from "../orchestrator/control-client.js";
import { notify } from "../notifications/service.js";
import { logger } from "../logger.js";

type Tenant = typeof tenants.$inferSelect;

/** Why a new device was refused. */
export type DeviceRefusal =
  | "locked_down"
  | "device_locked"
  | "device_limit"
  /** The control plane could not count the devices. */
  | "limit_unverified"
  /** Headscale mode: a non-originator must ask for a key first. */
  | "approval_required";

/** True when a cap is set (> 0) and `count` has reached it. */
export function isAtCapacity(count: number, max: number): boolean {
  return max > 0 && count >= max;
}

/** True when the member holds a device lock (Headscale mode). */
export async function isDeviceLocked(tenantId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: deviceLocks.id })
    .from(deviceLocks)
    .innerJoin(memberships, eq(deviceLocks.membershipId, memberships.id))
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Checks `maxDevices` before a new key or sign-in. At the cap it raises a
 * deduplicated device_limit_reached notification.
 */
export async function deviceLimitRefusal(
  tenant: Tenant,
  client: ControlClient,
): Promise<"device_limit" | "limit_unverified" | null> {
  if (tenant.maxDevices <= 0) return null;
  let count: number;
  try {
    // A device that waits for admission is counted when it is admitted
    count = (await client.listNodes()).filter(isAdmitted).length;
  } catch (err) {
    logger.error({ tenantId: tenant.id, err }, "failed to count devices for limit check");
    return "limit_unverified";
  }
  if (!isAtCapacity(count, tenant.maxDevices)) return null;

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
  return "device_limit";
}

/**
 * The first reason the member may not add a device, or null.
 * Order: lockdown, device lock, device limit, approval.
 * Device locks and key approval exist only in Headscale mode. The coordinator has the machine lock and holds every new device.
 */
export async function deviceAdmission(
  tenant: Tenant,
  membership: { isOriginator: boolean },
  userId: string,
  client: ControlClient = getControlClient(tenant),
): Promise<DeviceRefusal | null> {
  if (tenant.lockdownMode) return "locked_down";
  if (!useCoordinator && (await isDeviceLocked(tenant.id, userId))) return "device_locked";
  const limit = await deviceLimitRefusal(tenant, client);
  if (limit) return limit;
  if (!useCoordinator && tenant.requireDeviceApproval && !membership.isOriginator) return "approval_required";
  return null;
}
