/**
 * @module permissions
 *
 * Every discrete permission that can be granted via a role.
 *
 * Permissions are stored as a JSONB string array on each role row. The
 * originator membership bypasses this array entirely — see
 * {@link hasPermission} in `helpers.ts`. When adding a new permission,
 * append it here **and** add a label in {@link PERMISSION_LABELS}.
 */
export const ALL_PERMISSIONS = [
  "invite",
  "kick",
  "manage_roles",
  "manage_settings",
  "approve_devices",
  "approve_joins",
  "approve_services",
  "lock_devices",
  "view_audit_log",
  "manage_devices",
  "manage_services",
  "manage_board",
  "create_posts",
  "create_agent_tokens",
  "manage_agent_tokens",
] as const;

/** A single permission string from {@link ALL_PERMISSIONS}. */
export type Permission = (typeof ALL_PERMISSIONS)[number];

/** Human-readable labels for the dashboard UI. */
export const PERMISSION_LABELS: Record<Permission, string> = {
  invite: "Send & revoke invitations",
  kick: "Remove members from the tailnet",
  manage_roles: "Create, edit, delete, and assign roles",
  manage_settings: "Change tenant settings (lockdown, device approval, board)",
  approve_devices: "Approve or reject device join requests",
  approve_joins: "Approve or reject requests to join the tailnet",
  approve_services: "Approve or reject service devices and services",
  lock_devices: "Lock or unlock other members' device bindings",
  view_audit_log: "View the security audit log",
  manage_devices: "Delete any member's devices",
  manage_services: "Register, edit, and remove services and service devices",
  manage_board: "Control board settings and remove any post",
  create_posts: "Create and remove own posts on the public board",
  create_agent_tokens: "Create personal API tokens for agent access",
  manage_agent_tokens: "View and revoke any member's agent tokens",
};

/** Originator system role always has every permission. */
export const ORIGINATOR_PERMISSIONS: readonly Permission[] = ALL_PERMISSIONS;

/** Citizen system role starts with no extra permissions. */
export const DEFAULT_CITIZEN_PERMISSIONS: readonly Permission[] = [];
