/**
 * @module access/device-holds
 * Every new device waits until its owner admits that exact machine.
 * A tailnet can add a second step: an approver must admit it too.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { memberships, roles, users } from "../db/schema.js";
import type { DeviceHold } from "../orchestrator/headscale-api.js";

export type { DeviceHold };

export interface AdmitInput {
  hold: DeviceHold;
  /** The caller owns the device. */
  isOwner: boolean;
  /** The owner of the device is a member of the tailnet. */
  ownerIsMember: boolean;
  /** The caller holds `approve_devices` (the originator always does). */
  canApprove: boolean;
  /** The tailnet's second step (`tenants.requireDeviceApproval`). */
  secondApproval: boolean;
  /** An approver other than the owner of the device exists. */
  otherApprover: boolean;
}

/** The hold of a device. Headscale has no hold: its devices are admitted when they register. */
export function holdOf(node: { hold?: DeviceHold }): DeviceHold {
  return node.hold ?? "none";
}

export function isAdmitted(node: { hold?: DeviceHold }): boolean {
  return holdOf(node) === "none";
}

export type AdmitRefusal = "not_waiting" | "not_owner" | "not_approver";

/**
 * The hold of a device after its owner admitted it.
 * Security: with the second step, an approver does not approve their own device when another approver exists.
 */
export function holdAfterOwner(secondApproval: boolean, ownerCanApprove: boolean, otherApprover: boolean): DeviceHold {
  return secondApproval && (!ownerCanApprove || otherApprover) ? "approver" : "none";
}

/**
 * The next hold when the caller admits a device, or why the caller may not.
 * Security: only the owner takes the owner's step. An approver takes it only for a device without an owner.
 * The approver's step belongs to an approver who is not the owner. The owner finishes it only when
 * the tailnet dropped the second step, or when the owner is the only approver.
 */
export function admitStep(input: AdmitInput): { to: DeviceHold } | { refusal: AdmitRefusal } {
  switch (input.hold) {
    case "none":
      return { refusal: "not_waiting" };
    case "owner":
      if (input.isOwner) return { to: holdAfterOwner(input.secondApproval, input.canApprove, input.otherApprover) };
      if (input.canApprove && !input.ownerIsMember) return { to: "none" };
      return { refusal: "not_owner" };
    case "approver":
      if (input.isOwner) {
        if (!input.secondApproval || (input.canApprove && !input.otherApprover)) return { to: "none" };
        return { refusal: "not_approver" };
      }
      return input.canApprove ? { to: "none" } : { refusal: "not_approver" };
  }
}

export interface TenantMembers {
  /** Handle of each member, by user id. */
  handles: Map<string, string>;
  /** Members who take the second step: the originator and holders of `approve_devices`. */
  approvers: Set<string>;
}

/** The members of a tailnet and which of them approve devices. */
export async function tenantMembers(tenantId: string): Promise<TenantMembers> {
  const rows = await db
    .select({ userId: users.id, handle: users.handle, isOriginator: memberships.isOriginator, permissions: roles.permissions })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .leftJoin(roles, eq(memberships.roleId, roles.id))
    .where(eq(memberships.tenantId, tenantId));
  return {
    handles: new Map(rows.map((r) => [r.userId, r.handle])),
    approvers: new Set(rows.filter((r) => r.isOriginator || (r.permissions ?? []).includes("approve_devices")).map((r) => r.userId)),
  };
}

/** True when an approver other than `userId` exists. */
export function hasOtherApprover(members: TenantMembers, userId: string | null): boolean {
  return [...members.approvers].some((id) => id !== userId);
}

/** The hold of a new device of `userId` after their own admission: asks the database only when the second step is on. */
export async function holdAfterOwnerFor(
  tenant: { id: string; requireDeviceApproval: boolean },
  canApprove: boolean,
  userId: string,
): Promise<DeviceHold> {
  if (!tenant.requireDeviceApproval) return "none";
  return holdAfterOwner(true, canApprove, hasOtherApprover(await tenantMembers(tenant.id), userId));
}
