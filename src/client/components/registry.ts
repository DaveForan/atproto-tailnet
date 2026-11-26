import type { Settings, SettingsSectionId, TabId, Tenant, User } from "../lib/types";

type HasPerm = (p: string) => boolean;
type GateFn = (hasPerm: HasPerm, settings: Settings | null, tenant: Tenant | null) => boolean;

interface Gated {
  label: string;
  gate: GateFn;
  feature?: keyof NonNullable<User["features"]>;
  operatorOnly?: boolean;
}

export interface TabEntry extends Gated {
  id: TabId;
}

export interface PageSection extends Gated {
  id: string;
}

export interface SettingsSection extends PageSection {
  id: SettingsSectionId;
}

export interface Route {
  tab: TabId;
  /** A sub-view of the page; null means its first one. */
  section: string | null;
}

const always: GateFn = () => true;
const perm =
  (...perms: string[]): GateFn =>
  (hp) =>
    perms.some((p) => hp(p));

export const settingsSections: SettingsSection[] = [
  { id: "security", label: "Security", gate: perm("manage_settings") },
  { id: "limits", label: "Limits", gate: (hp, _s, t) => !!t?.isOriginator || hp("manage_settings") },
  { id: "notifications", label: "Notifications", gate: perm("manage_settings", "approve_devices", "approve_joins", "approve_services") },
  { id: "roles", label: "Roles", gate: perm("manage_roles") },
  { id: "acl", label: "Access rules", gate: perm("manage_acl") },
  { id: "relays", label: "Relays", gate: perm("manage_acl") },
  { id: "routes", label: "Routes", gate: perm("manage_devices") },
  // The coordinator assigns address ranges itself; the IP ranges API answers 501 there
  { id: "ipconfig", label: "IP ranges", gate: (hp, _s, t) => hp("manage_settings") && !t?.coordinatorMode },
  { id: "agents", label: "Agent tokens", gate: (_hp, s) => !!s?.allowAgentTokens },
  { id: "collectives", label: "Sub-collectives", gate: perm("manage_sub_collectives") },
  { id: "audit", label: "Audit log", gate: perm("view_audit_log") },
  { id: "federation", label: "Federation", gate: perm("manage_settings"), feature: "federation" },
  { id: "traversal", label: "Traversal policy", gate: perm("manage_settings"), feature: "federation" },
  { id: "credentials", label: "Credentials", gate: perm("manage_settings"), feature: "federation" },
];

function gateOpen(
  entry: Gated,
  hasPerm: HasPerm,
  settings: Settings | null,
  tenant: Tenant | null,
  user: User | null,
): boolean {
  if (entry.feature && !user?.features?.[entry.feature]) return false;
  if (entry.operatorOnly && !user?.isOperator) return false;
  return entry.gate(hasPerm, settings, tenant);
}

/** The sub-views of each page that has them; route `#<page>/<section>`. */
export const pageSections: Partial<Record<TabId, PageSection[]>> = {
  devices: [
    { id: "list", label: "Devices", gate: always },
    { id: "add", label: "Add a device", gate: always },
    { id: "access", label: "Access", gate: always },
  ],
  people: [
    { id: "members", label: "Members", gate: always },
    { id: "invite", label: "Invitations", gate: perm("invite") },
  ],
  board: [
    { id: "board", label: "Board", gate: always },
    { id: "mine", label: "My services", gate: always },
    { id: "queue", label: "Approval queue", gate: perm("approve_services") },
    { id: "settings", label: "Board settings", gate: (hp, _s, t) => !!t?.isOriginator || hp("manage_settings") },
  ],
  sharing: [
    { id: "shares", label: "Shared devices", gate: always },
    { id: "friends", label: "Friends", gate: always },
  ],
  settings: settingsSections,
};

/** The sections of a page that this user may open, in menu order. */
export function visibleSections(
  tab: TabId,
  hasPerm: HasPerm,
  settings: Settings | null,
  tenant: Tenant | null,
  user: User | null,
): PageSection[] {
  return (pageSections[tab] ?? []).filter((s) => gateOpen(s, hasPerm, settings, tenant, user));
}

export const tabRegistry: TabEntry[] = [
  { id: "overview", label: "Overview", gate: always },
  { id: "devices", label: "Devices", gate: always },
  { id: "people", label: "People", gate: always },
  { id: "board", label: "Services", gate: always },
  { id: "sharing", label: "Sharing", gate: always },
  { id: "settings", label: "Settings", gate: always },
  { id: "account", label: "Account", gate: always },
  { id: "instance", label: "Instance", gate: always, operatorOnly: true },
];

export function tabEnabled(
  entry: TabEntry,
  hasPerm: HasPerm,
  settings: Settings | null,
  tenant: Tenant | null,
  user: User | null,
): boolean {
  if (entry.id === "settings") return visibleSections("settings", hasPerm, settings, tenant, user).length > 0;
  return gateOpen(entry, hasPerm, settings, tenant, user);
}

/** Hashes of earlier dashboards; stored notifications and bookmarks still carry them. */
const LEGACY_ROUTES: Record<string, Route> = {
  status: { tab: "overview", section: null },
  connect: { tab: "devices", section: "add" },
  members: { tab: "people", section: null },
  invite: { tab: "people", section: "invite" },
  claude: { tab: "account", section: null },
  security: { tab: "settings", section: "security" },
  usage: { tab: "settings", section: "limits" },
  derp: { tab: "settings", section: "relays" },
};

/** Reads a URL hash without its "#": "devices", "settings/roles" or an earlier tab name. */
export function parseRoute(hash: string): Route | null {
  const [head, sub] = hash.split("/", 2);
  if (tabRegistry.some((e) => e.id === head)) {
    const tab = head as TabId;
    return { tab, section: pageSections[tab]?.find((s) => s.id === sub)?.id ?? null };
  }
  if (LEGACY_ROUTES[head]) return LEGACY_ROUTES[head];
  const section = settingsSections.find((s) => s.id === head);
  return section ? { tab: "settings", section: section.id } : null;
}

export function routeHash(route: Route): string {
  return route.section ? `${route.tab}/${route.section}` : route.tab;
}
