import { lazy, Suspense, useEffect, useState } from "react";
import { useApp } from "./hooks/useAppState";
import { Header, LockdownBanner, LoginPage, Sidebar, SidebarProvider, StatsSummary } from "./components/Layout";
import { PendingInvitations } from "./components/PendingInvitations";
import { InvitePage, NoAccessPage, SuspendedPage } from "./components/AccessPages";
import type { HostnamesData, TabId, Tenant } from "./lib/types";
import { AddressForm } from "./components/TailnetAddress";
import { hostnamesService } from "./services/hostnames";

const StatusTab = lazy(() => import("./tabs/StatusTab").then((m) => ({ default: m.StatusTab })));
const DevicesTab = lazy(() => import("./tabs/DevicesTab").then((m) => ({ default: m.DevicesTab })));
const MembersTab = lazy(() => import("./tabs/MembersTab").then((m) => ({ default: m.MembersTab })));
const ConnectTab = lazy(() => import("./tabs/ConnectTab").then((m) => ({ default: m.ConnectTab })));
const InviteTab = lazy(() => import("./tabs/InviteTab").then((m) => ({ default: m.InviteTab })));
const RoutesTab = lazy(() => import("./tabs/RoutesTab").then((m) => ({ default: m.RoutesTab })));
const IpConfigTab = lazy(() => import("./tabs/IpConfigTab").then((m) => ({ default: m.IpConfigTab })));
const DerpTab = lazy(() => import("./tabs/DerpTab").then((m) => ({ default: m.DerpTab })));
const BoardsTab = lazy(() => import("./tabs/BoardsTab").then((m) => ({ default: m.BoardsTab })));
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

const INVITE_PATH = /^\/invite\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

export function App() {
  const { user, loading, error, currentTenant, showWizard, reload, reloadAndSelect } = useApp();
  const [path, setPath] = useState(window.location.pathname);
  const inviteId = INVITE_PATH.exec(path)?.[1] ?? null;

  if (loading) {
    return <div className="loading-screen">Loading...</div>;
  }

  if (error && !user) {
    return (
      <div className="loading-screen">
        <p>Failed to load the dashboard: {error}</p>
        <button onClick={() => { void reload(); }}>Retry</button>
      </div>
    );
  }

  if (!user) {
    return <LoginPage redirect={inviteId ? `/invite/${inviteId.toLowerCase()}` : undefined} />;
  }

  if (inviteId) {
    const done = (slug?: string) => {
      history.replaceState(null, "", "/");
      setPath("/");
      void (slug ? reloadAndSelect(slug) : reload());
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
        <div className="lockdown-banner">
          <span>{error}</span>
          <button className="btn-sm btn-warning" onClick={() => { void reload(); }}>Retry</button>
        </div>
      )}
      {!currentTenant ? <NoAccessPage /> : suspendedForMe ? <SuspendedPage /> : <Dashboard />}
    </SidebarProvider>
  );
}

function Dashboard() {
  const { tab, invitations, currentTenant, reload, setTab } = useApp();
  const TabComponent = tabComponents[tab] ?? StatusTab;

  return (
    <div className="dashboard-layout">
      <Sidebar />
      <main>
        {currentTenant?.suspended && (
          <div className="suspended-banner" role="status">
            <span>
              {currentTenant.name} is suspended. Its members can&apos;t use it and its devices can&apos;t
              connect until you unsuspend it.
            </span>
            {tab !== "instance" && (
              <button className="btn-sm btn-warning" onClick={() => setTab("instance")}>Manage</button>
            )}
          </div>
        )}
        <PendingInvitations invitations={invitations} onAction={() => { void reload(); }} />
        <StatsSummary />
        <Suspense key={currentTenant?.id} fallback={<div className="tab-loading">Loading...</div>}>
          <TabComponent />
        </Suspense>
      </main>
    </div>
  );
}

function SetupWizard({ tenant }: { tenant: Tenant }) {
  const { wizardStep, setWizardStep, dismissWizard, reload } = useApp();
  const [address, setAddress] = useState<HostnamesData | null>(null);

  useEffect(() => {
    hostnamesService
      .list(tenant.id)
      .then((d) => d && setAddress(d))
      .catch(() => setAddress(null));
  }, [tenant.id]);

  const loginServer = address?.loginServer ?? "https://<login-server>";

  return (
    <div className="wizard-overlay">
      <div className="wizard-card">
        <h2>Welcome to {tenant.name}</h2>
        {wizardStep === 1 && tenant.isOriginator && address && (
          <div>
            <p>
              Your tailnet is ready. First, choose its address — the public name used in
              join and board links{address.sharedControl ? "" : ", and the server your devices connect to"}.
              You can change it later; old addresses keep working as aliases.
            </p>
            <AddressForm
              tenantId={tenant.id}
              initial={address.primary}
              baseDomain={address.baseDomain}
              sharedControl={address.sharedControl}
              submitLabel="Use this address"
              onSaved={(primary) => {
                setAddress({ ...address, primary });
                void reload();
                setWizardStep(2);
              }}
              secondary={
                <button type="button" className="btn-ghost" onClick={() => setWizardStep(2)}>
                  Keep {address.primary}
                </button>
              }
            />
          </div>
        )}
        {wizardStep === 1 && !(tenant.isOriginator && address) && (
          <div>
            <p>Your tailnet is ready. Let&apos;s connect your first device.</p>
            <div className="wizard-actions">
              <button onClick={() => setWizardStep(2)}>Get Started</button>
              <button className="btn-ghost" onClick={dismissWizard}>
                Skip
              </button>
            </div>
          </div>
        )}
        {wizardStep === 2 && (
          <div>
            <p>
              Install <a href="https://tailscale.com/download" target="_blank" rel="noopener">Tailscale</a> on your device, then go to the <strong>Add Device</strong> tab to generate an auth key.
            </p>
            <div className="wizard-actions">
              <button onClick={() => setWizardStep(3)}>Next</button>
              <button className="btn-ghost" onClick={() => setWizardStep(1)}>Back</button>
            </div>
          </div>
        )}
        {wizardStep === 3 && (
          <div>
            <p>Run this command with your auth key:</p>
            <code className="code-block">
              tailscale up --login-server {loginServer} --authkey YOUR_KEY
            </code>
            <div className="wizard-actions">
              <button onClick={dismissWizard}>Go to Dashboard</button>
              <button className="btn-ghost" onClick={() => setWizardStep(2)}>Back</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
