import type { Settings, TabId, Tenant, User } from "../lib/types";

type GateFn = (
  hasPerm: (p: string) => boolean,
  settings: Settings | null,
  tenant: Tenant | null,
) => boolean;

export interface TabEntry {
  id: TabId;
  label: string;
  group: string;
  gate: GateFn;
  feature?: keyof NonNullable<User["features"]>;
}

export interface TabGroup {
  label: string;
  tabs: TabEntry[];
}

const always: GateFn = () => true;
const perm =
  (...perms: string[]): GateFn =>
  (hp) =>
    perms.some((p) => hp(p));

export const tabRegistry: TabEntry[] = [
  // Network
  { id: "status", label: "Status", group: "Network", gate: always },
  { id: "derp", label: "DERP Relays", group: "Network", gate: perm("manage_acl") },
  { id: "ipconfig", label: "IP Ranges", group: "Network", gate: perm("manage_settings") },
  { id: "routes", label: "Routes", group: "Network", gate: perm("manage_devices") },
  { id: "devices", label: "Devices", group: "Network", gate: always },
  { id: "members", label: "Members", group: "Network", gate: always },
  { id: "connect", label: "Add Device", group: "Network", gate: always },

  // Manage
  { id: "invite", label: "Invite", group: "Manage", gate: perm("invite") },
  { id: "services", label: "Services", group: "Manage", gate: perm("manage_services", "approve_services") },
  { id: "board", label: "Board", group: "Manage", gate: perm("manage_board", "create_posts") },
  { id: "federation", label: "Federation", group: "Manage", gate: perm("manage_settings"), feature: "federation" },
  { id: "collectives", label: "Sub-Collectives", group: "Manage", gate: perm("manage_sub_collectives") },
  { id: "traversal", label: "Traversal Policy", group: "Manage", gate: perm("manage_settings"), feature: "federation" },

  // Access Control
  { id: "roles", label: "Roles", group: "Access Control", gate: perm("manage_roles") },
  { id: "agents", label: "Agents", group: "Access Control", gate: (_hp, s) => !!s?.allowAgentTokens },
  { id: "acl", label: "ACL", group: "Access Control", gate: perm("manage_acl") },
  { id: "credentials", label: "Credentials", group: "Access Control", gate: perm("manage_settings") },

  // Admin
  { id: "usage", label: "Usage", group: "Admin", gate: always },
  { id: "security", label: "Security", group: "Admin", gate: perm("manage_settings", "approve_devices", "approve_joins", "approve_services") },
  { id: "audit", label: "Audit Log", group: "Admin", gate: perm("view_audit_log") },
];

export function tabEnabled(
  entry: TabEntry,
  hasPerm: (p: string) => boolean,
  settings: Settings | null,
  tenant: Tenant | null,
  features: User["features"],
): boolean {
  if (entry.feature && !features?.[entry.feature]) return false;
  return entry.gate(hasPerm, settings, tenant);
}
