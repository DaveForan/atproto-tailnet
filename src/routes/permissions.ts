/** Every discrete permission that can be granted via a role. */
export const ALL_PERMISSIONS = [
  "invite",
  "kick",
  "manage_roles",
  "manage_settings",
  "approve_devices",
  "approve_joins",
  "lock_devices",
  "view_audit_log",
  "manage_devices",
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

/** Human-readable labels for the dashboard UI. */
export const PERMISSION_LABELS: Record<Permission, string> = {
  invite: "Send & revoke invitations",
  kick: "Remove members from the tailnet",
  manage_roles: "Create, edit, delete, and assign roles",
  manage_settings: "Change tenant settings (lockdown, device approval)",
  approve_devices: "Approve or reject device join requests",
  approve_joins: "Approve or reject requests to join the tailnet",
  lock_devices: "Lock or unlock other members' device bindings",
  view_audit_log: "View the security audit log",
  manage_devices: "Delete any member's devices",
};

/** Originator system role always has every permission. */
export const ORIGINATOR_PERMISSIONS: readonly Permission[] = ALL_PERMISSIONS;

/** Citizen system role starts with no extra permissions. */
export const DEFAULT_CITIZEN_PERMISSIONS: readonly Permission[] = [];
