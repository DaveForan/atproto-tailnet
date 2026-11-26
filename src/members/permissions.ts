/** Every permission a role can grant. A new permission also needs a label in {@link PERMISSION_LABELS}. */
import { z } from "zod";

export const ALL_PERMISSIONS = [
  "invite",
  "kick",
  "manage_roles",
  "manage_settings",
  "approve_devices",
  "approve_joins",
  "approve_services",
  "view_audit_log",
  "manage_devices",
  "manage_services",
  "manage_board",
  "create_posts",
  "create_agent_tokens",
  "manage_agent_tokens",
  "manage_acl",
  "manage_sub_collectives",
] as const;

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
  view_audit_log: "View the security audit log",
  manage_devices: "Delete any member's devices",
  manage_services: "Register, edit, and remove services and service devices",
  manage_board: "Control board settings and remove any post",
  create_posts: "Create and remove own posts on the public board",
  create_agent_tokens: "Create personal API tokens for agent access",
  manage_agent_tokens: "View and revoke any member's agent tokens",
  manage_acl: "View and edit network access control rules",
  manage_sub_collectives: "Create, manage, and detach sub-collectives",
};

export const ORIGINATOR_PERMISSIONS: readonly Permission[] = ALL_PERMISSIONS;

export const DEFAULT_CITIZEN_PERMISSIONS: readonly Permission[] = [];

/** Originators hold all permissions. Others hold the known role permissions, narrowed to the token scope. */
export function effectivePermissions(
  membership: { isOriginator: boolean },
  role: { permissions: unknown } | null,
  tokenScope?: readonly string[] | null,
): Permission[] {
  const known = ALL_PERMISSIONS as readonly string[];
  const base: Permission[] = membership.isOriginator
    ? [...ALL_PERMISSIONS]
    : ((role?.permissions ?? []) as string[]).filter((p): p is Permission => known.includes(p));
  return tokenScope ? base.filter((p) => tokenScope.includes(p)) : base;
}

export const permissionsSchema = z.array(z.enum(ALL_PERMISSIONS));
