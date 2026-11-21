import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useSession } from "./hooks/session";
import { useTabRoute } from "./hooks/useTabRoute";
import { useWizard } from "./hooks/useWizard";
import { Header, LockdownBanner, LoginPage, Sidebar, SidebarProvider, StatsSummary } from "./components/Layout";
import { PendingInvitations } from "./components/PendingInvitations";
import { Loading } from "./components/Loading";
import { InvitePage, NoAccessPage, SuspendedPage } from "./components/AccessPages";
import { DeviceSignInPage } from "./components/DeviceSignIn";
import { VerifyDevicePage } from "./components/VerifyDevice";
import { SetupWizard } from "./components/SetupWizard";
import { tabRegistry } from "./components/registry";
import { usePathRoute } from "./hooks/usePathRoute";
import type { TabId } from "./lib/types";
import { onSessionExpired, SESSION_EXPIRED_MESSAGE } from "./services/api";

const StatusTab = lazy(() => import("./tabs/StatusTab").then((m) => ({ default: m.StatusTab })));
const DevicesTab = lazy(() => import("./tabs/DevicesTab").then((m) => ({ default: m.DevicesTab })));
const MembersTab = lazy(() => import("./tabs/MembersTab").then((m) => ({ default: m.MembersTab })));
const ConnectTab = lazy(() => import("./tabs/ConnectTab").then((m) => ({ default: m.ConnectTab })));
const InviteTab = lazy(() => import("./tabs/InviteTab").then((m) => ({ default: m.InviteTab })));
const RoutesTab = lazy(() => import("./tabs/RoutesTab").then((m) => ({ default: m.RoutesTab })));
const IpConfigTab = lazy(() => import("./tabs/IpConfigTab").then((m) => ({ default: m.IpConfigTab })));
const DerpTab = lazy(() => import("./tabs/DerpTab").then((m) => ({ default: m.DerpTab })));
const BoardsTab = lazy(() => import("./tabs/BoardsTab").then((m) => ({ default: m.BoardsTab })));
const AccountTab = lazy(() => import("./tabs/AccountTab").then((m) => ({ default: m.AccountTab })));
const SharingTab = lazy(() => import("./tabs/SharingTab").then((m) => ({ default: m.SharingTab })));
const FederationTab = lazy(() => import("./tabs/FederationTab").then((m) => ({ default: m.FederationTab })));
const CollectivesTab = lazy(() => import("./tabs/CollectivesTab").then((m) => ({ default: m.CollectivesTab })));
const TraversalTab = lazy(() => import("./tabs/TraversalTab").then((m) => ({ default: m.TraversalTab })));
const RolesTab = lazy(() => import("./tabs/RolesTab").then((m) => ({ default: m.RolesTab })));
const AgentsTab = lazy(() => import("./tabs/AgentsTab").then((m) => ({ default: m.AgentsTab })));
const AclTab = lazy(() => import("./tabs/AclTab").then((m) => ({ default: m.AclTab })));
const CredentialsTab = lazy(() => import("./tabs/CredentialsTab").then((m) => ({ default: m.CredentialsTab })));
const UsageTab = lazy(() => import("./tabs/UsageTab").then((m) => ({ default: m.UsageTab })));
const SecurityTab = lazy(() => import("./tabs/SecurityTab").then((m) => ({ default: m.SecurityTab })));
const AuditTab = lazy(() => import("./tabs/AuditTab").then((m) => ({ default: m.AuditTab })));
const ClaudeTab = lazy(() => import("./tabs/ClaudeTab").then((m) => ({ default: m.ClaudeTab })));
const InstanceTab = lazy(() => import("./tabs/InstanceTab").then((m) => ({ default: m.InstanceTab })));

const tabComponents: Record<TabId, React.LazyExoticComponent<React.ComponentType>> = {
  status: StatusTab,
  devices: DevicesTab,
  members: MembersTab,
  connect: ConnectTab,
  invite: InviteTab,
  routes: RoutesTab,
  ipconfig: IpConfigTab,
  derp: DerpTab,
  board: BoardsTab,
  sharing: SharingTab,
  account: AccountTab,
  federation: FederationTab,
  collectives: CollectivesTab,
  traversal: TraversalTab,
  roles: RolesTab,
  agents: AgentsTab,
  acl: AclTab,
  credentials: CredentialsTab,
  usage: UsageTab,
  security: SecurityTab,
  audit: AuditTab,
  claude: ClaudeTab,
  instance: InstanceTab,
};

/**
 * The session ended while the dashboard was open (an API call answered 401).
 * Nothing on the page can succeed any more: say so and offer the sign-in.
 */
function SessionExpired() {
  const [expired, setExpired] = useState(false);
  const signIn = useRef<HTMLButtonElement>(null);
  useEffect(() => onSessionExpired(() => setExpired(true)), []);
  useEffect(() => {
    if (expired) signIn.current?.focus();
  }, [expired]);
  if (!expired) return null;
  return (
    <div className="session-expired-backdrop">
      <div className="session-expired" role="alertdialog" aria-modal="true" aria-labelledby="session-expired-title">
        <h2 id="session-expired-title">{SESSION_EXPIRED_MESSAGE}</h2>
        <p>You were signed out, so changes cannot be saved. Sign in again to continue.</p>
        <button ref={signIn} type="button" className="mt-12" onClick={() => window.location.reload()}>
          Sign in again
        </button>
      </div>
    </div>
  );
}

export function App() {
  return (
    <>
      <AppContent />
      <SessionExpired />
    </>
  );
}

function AppContent() {
  const { user, loading, error, currentTenant, reload, reloadAndSelect } = useSession();
  const { showWizard } = useWizard();
  const { verifyDevice, inviteId, deviceId, goHome } = usePathRoute();

  // Second step of sign-in for accounts with trusted devices (no session yet)
  if (verifyDevice) {
    return <VerifyDevicePage />;
  }

  if (loading) {
    return <div className="loading-screen" role="status">Loading…</div>;
  }

  if (error && !user) {
    return (
      <div className="loading-screen loading-screen-error" role="alert">
        <p>Failed to load the dashboard: {error}</p>
        <button type="button" onClick={() => { void reload(); }}>Retry</button>
      </div>
    );
  }

  if (!user) {
    const redirect = inviteId ? `/invite/${inviteId.toLowerCase()}` : deviceId ? `/device/${deviceId}` : undefined;
    return <LoginPage redirect={redirect} purpose={deviceId ? "device" : inviteId ? "invite" : undefined} />;
  }

  // After a recovery code, the only thing available is to trust this device
  if (user.mustEnrollDevice) {
    return (
      <>
        <Header minimal />
        <main className="access-main">
          <Suspense fallback={<Loading />}>
            <AccountTab onChanged={() => { void reload(); }} />
          </Suspense>
        </main>
      </>
    );
  }

  if (deviceId) {
    const done = () => {
      goHome();
      void reload();
    };
    return (
      <>
        <Header minimal />
        <DeviceSignInPage id={deviceId} onDone={done} />
      </>
    );
  }

  if (inviteId) {
    const done = (tenantId?: string) => {
      goHome();
      void (tenantId ? reloadAndSelect(tenantId) : reload());
    };
    return (
      <>
        <Header minimal />
        <InvitePage id={inviteId} onDone={done} />
      </>
    );
  }

  const suspendedForMe = !!currentTenant?.suspended && !user.isOperator;

  if (showWizard && currentTenant && !suspendedForMe) {
    return <SetupWizard tenant={currentTenant} />;
  }

  return (
    <SidebarProvider>
      <Header minimal={!currentTenant || suspendedForMe} />
      {!suspendedForMe && <LockdownBanner />}
      {error && (
        <div className="lockdown-banner" role="alert">
          <span>{error}</span>
          <button type="button" className="btn-sm btn-warning" onClick={() => { void reload(); }}>Retry</button>
        </div>
      )}
      {!currentTenant ? <NoAccessPage /> : suspendedForMe ? <SuspendedPage /> : <Dashboard />}
    </SidebarProvider>
  );
}

const APP_NAME = "atproto-tailnet";

function Dashboard() {
  const { invitations, currentTenant, reloadInvitations, reloadTenants } = useSession();
  const { tab, setTab, navCount } = useTabRoute();
  const TabComponent = tabComponents[tab] ?? StatusTab;
  const label = tabRegistry.find((e) => e.id === tab)?.label ?? "Status";
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    document.title = currentTenant ? `${label} · ${currentTenant.name} · ${APP_NAME}` : APP_NAME;
  }, [label, currentTenant?.name]);

  // Screen readers and keyboard users land on the new page; the first load keeps the browser's focus
  useEffect(() => {
    if (navCount > 0) headingRef.current?.focus();
  }, [navCount]);

  return (
    <div className="dashboard-layout">
      <Sidebar />
      <main>
        <h2 ref={headingRef} tabIndex={-1} className="tab-title">{label}</h2>
        {currentTenant?.suspended && (
          <div className="suspended-banner" role="status">
            <span>
              {currentTenant.name} is suspended. Its members can&apos;t use it and its devices can&apos;t
              connect until you unsuspend it.
            </span>
            {tab !== "instance" && (
              <button type="button" className="btn-sm btn-warning" onClick={() => setTab("instance")}>Manage</button>
            )}
          </div>
        )}
        <PendingInvitations
          invitations={invitations}
          onAction={() => { void reloadInvitations(); void reloadTenants(); }}
        />
        <StatsSummary />
        <Suspense key={currentTenant?.id} fallback={<Loading />}>
          <TabComponent />
        </Suspense>
      </main>
    </div>
  );
}
