import { Suspense, lazy, type ComponentType, type LazyExoticComponent } from "react";
import { Loading } from "../components/Loading";
import { SubNav, useSections } from "../components/SubNav";
import type { SettingsSectionId } from "../lib/types";

const sections: Record<SettingsSectionId, LazyExoticComponent<ComponentType>> = {
  security: lazy(() => import("./settings/SecuritySection").then((m) => ({ default: m.SecuritySection }))),
  limits: lazy(() => import("./settings/LimitsSection").then((m) => ({ default: m.LimitsSection }))),
  notifications: lazy(() => import("./settings/NotificationsSection").then((m) => ({ default: m.NotificationsSection }))),
  roles: lazy(() => import("./RolesTab").then((m) => ({ default: m.RolesTab }))),
  acl: lazy(() => import("./AclTab").then((m) => ({ default: m.AclTab }))),
  relays: lazy(() => import("./DerpTab").then((m) => ({ default: m.DerpTab }))),
  routes: lazy(() => import("./RoutesTab").then((m) => ({ default: m.RoutesTab }))),
  ipconfig: lazy(() => import("./IpConfigTab").then((m) => ({ default: m.IpConfigTab }))),
  agents: lazy(() => import("./AgentsTab").then((m) => ({ default: m.AgentsTab }))),
  collectives: lazy(() => import("./CollectivesTab").then((m) => ({ default: m.CollectivesTab }))),
  audit: lazy(() => import("./AuditTab").then((m) => ({ default: m.AuditTab }))),
  federation: lazy(() => import("./FederationTab").then((m) => ({ default: m.FederationTab }))),
  traversal: lazy(() => import("./TraversalTab").then((m) => ({ default: m.TraversalTab }))),
  credentials: lazy(() => import("./CredentialsTab").then((m) => ({ default: m.CredentialsTab }))),
};

export function SettingsTab() {
  const { sections: visible, open } = useSections("settings");
  const Section = open ? sections[open.id as SettingsSectionId] : null;

  return (
    <>
      <SubNav tab="settings" label="Settings sections" sections={visible} open={open} />
      {open && Section && (
        <Suspense key={open.id} fallback={<Loading />}>
          <Section />
        </Suspense>
      )}
    </>
  );
}
