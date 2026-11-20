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
  operatorOnly?: boolean;
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
  { id: "derp", label: "DERP relays", group: "Network", gate: perm("manage_acl") },
  // The coordinator assigns address ranges itself; the IP ranges API answers 501 there
  { id: "ipconfig", label: "IP ranges", group: "Network", gate: (hp, _s, t) => hp("manage_settings") && !t?.coordinatorMode },
  { id: "routes", label: "Routes", group: "Network", gate: perm("manage_devices") },
  { id: "devices", label: "Devices", group: "Network", gate: always },
  { id: "members", label: "Members", group: "Network", gate: always },
  { id: "connect", label: "Add device", group: "Network", gate: always },

  // Manage
  { id: "invite", label: "Invite", group: "Manage", gate: perm("invite") },
  { id: "board", label: "Boards", group: "Network", gate: always },
  { id: "sharing", label: "Friends & sharing", group: "Network", gate: always },
  { id: "federation", label: "Federation", group: "Manage", gate: perm("manage_settings"), feature: "federation" },
  { id: "collectives", label: "Sub-collectives", group: "Manage", gate: perm("manage_sub_collectives") },
  { id: "traversal", label: "Traversal policy", group: "Manage", gate: perm("manage_settings"), feature: "federation" },

  // Access Control
  { id: "roles", label: "Roles", group: "Access control", gate: perm("manage_roles") },
  { id: "agents", label: "Agents", group: "Access control", gate: (_hp, s) => !!s?.allowAgentTokens },
  { id: "acl", label: "ACL", group: "Access control", gate: perm("manage_acl") },
  { id: "credentials", label: "Credentials", group: "Access control", gate: perm("manage_settings") },

  // Admin
  { id: "usage", label: "Usage", group: "Admin", gate: always },
  { id: "security", label: "Security", group: "Admin", gate: perm("manage_settings", "approve_devices", "approve_joins", "approve_services") },
  { id: "audit", label: "Audit log", group: "Admin", gate: perm("view_audit_log") },

  // Account
  { id: "account", label: "Account", group: "Account", gate: always },
  { id: "claude", label: "Connect Claude", group: "Account", gate: always },

  // Operator
  { id: "instance", label: "Instance", group: "Operator", gate: always, operatorOnly: true },
];

export function tabEnabled(
  entry: TabEntry,
  hasPerm: (p: string) => boolean,
  settings: Settings | null,
  tenant: Tenant | null,
  user: User | null,
): boolean {
  if (entry.feature && !user?.features?.[entry.feature]) return false;
  if (entry.operatorOnly && !user?.isOperator) return false;
  return entry.gate(hasPerm, settings, tenant);
}
