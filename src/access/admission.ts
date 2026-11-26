/**
 * @module access/admission
 * Whether a member may ask to add a device: lockdown and the device limit. Routes map the refusal codes to HTTP.
 * A key or sign-in never admits a device by itself: see `access/device-holds.ts`.
 */

import { isAdmitted } from "./device-holds.js";
import type { tenants } from "../db/schema.js";
import type { CoordinatorApiClient } from "../orchestrator/coordinator-api.js";
import { getCoordinatorClient } from "../orchestrator/control-client.js";
import { notify } from "../notifications/service.js";
import { logger } from "../logger.js";

type Tenant = typeof tenants.$inferSelect;

/** Why a new device was refused. */
export type DeviceRefusal =
  | "locked_down"
  | "device_limit"
  /** The control plane could not count the devices. */
  | "limit_unverified";

/** True when a cap is set (> 0) and `count` has reached it. */
export function isAtCapacity(count: number, max: number): boolean {
  return max > 0 && count >= max;
}

/**
 * Checks `maxDevices` before a new key or sign-in. At the cap it raises a
 * deduplicated device_limit_reached notification.
 */
export async function deviceLimitRefusal(
  tenant: Tenant,
  client: CoordinatorApiClient,
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

/** The first reason a member may not add a device, or null. Order: lockdown, device limit. */
export async function deviceAdmission(
  tenant: Tenant,
  client: CoordinatorApiClient = getCoordinatorClient(tenant),
): Promise<DeviceRefusal | null> {
  if (tenant.lockdownMode) return "locked_down";
  return deviceLimitRefusal(tenant, client);
}
