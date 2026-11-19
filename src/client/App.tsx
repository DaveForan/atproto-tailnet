import { lazy, Suspense } from "react";
import { errorMessage } from "./lib/utils";
import { useApp } from "./hooks/useAppState";
import { Header, LockdownBanner, LoginPage, Sidebar, SidebarProvider, StatsSummary } from "./components/Layout";
import { invitationService } from "./services/invitations";
import { useToast } from "./components/Toast";
import type { TabId, Tenant } from "./lib/types";

const StatusTab = lazy(() => import("./tabs/StatusTab").then((m) => ({ default: m.StatusTab })));
const DevicesTab = lazy(() => import("./tabs/DevicesTab").then((m) => ({ default: m.DevicesTab })));
const MembersTab = lazy(() => import("./tabs/MembersTab").then((m) => ({ default: m.MembersTab })));
const ConnectTab = lazy(() => import("./tabs/ConnectTab").then((m) => ({ default: m.ConnectTab })));
const InviteTab = lazy(() => import("./tabs/InviteTab").then((m) => ({ default: m.InviteTab })));
const RoutesTab = lazy(() => import("./tabs/RoutesTab").then((m) => ({ default: m.RoutesTab })));
const IpConfigTab = lazy(() => import("./tabs/IpConfigTab").then((m) => ({ default: m.IpConfigTab })));
const DerpTab = lazy(() => import("./tabs/DerpTab").then((m) => ({ default: m.DerpTab })));
const ServicesTab = lazy(() => import("./tabs/ServicesTab").then((m) => ({ default: m.ServicesTab })));
const BoardTab = lazy(() => import("./tabs/BoardTab").then((m) => ({ default: m.BoardTab })));
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

const tabComponents: Record<TabId, React.LazyExoticComponent<React.ComponentType>> = {
  status: StatusTab,
  devices: DevicesTab,
  members: MembersTab,
  connect: ConnectTab,
  invite: InviteTab,
  routes: RoutesTab,
  ipconfig: IpConfigTab,
  derp: DerpTab,
  services: ServicesTab,
  board: BoardTab,
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
};

export function App() {
  const { user, loading, error, currentTenant, showWizard, reload } = useApp();

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
    return <LoginPage />;
  }

  if (showWizard && currentTenant) {
    return <SetupWizard tenant={currentTenant} />;
  }

  return (
    <SidebarProvider>
      <Header />
      <LockdownBanner />
      {error && (
        <div className="lockdown-banner">
          <span>{error}</span>
          <button className="btn-sm btn-warning" onClick={() => { void reload(); }}>Retry</button>
        </div>
      )}
      {currentTenant ? <Dashboard /> : (
        <main className="centered-main">
          <div className="empty-state">No tailnets found.</div>
        </main>
      )}
    </SidebarProvider>
  );
}

function Dashboard() {
  const { tab, invitations, currentTenant, reload } = useApp();
  const TabComponent = tabComponents[tab] ?? StatusTab;

  return (
    <div className="dashboard-layout">
      <Sidebar />
      <main>
        <PendingInvitations invitations={invitations} onAction={reload} />
        <StatsSummary />
        <Suspense key={currentTenant?.id} fallback={<div className="tab-loading">Loading...</div>}>
          <TabComponent />
        </Suspense>
      </main>
    </div>
  );
}

function PendingInvitations({
  invitations,
  onAction,
}: {
  invitations: Array<{ id: string; tenantName: string; inviterHandle: string; inviterDisplayName?: string }>;
  onAction: () => void;
}) {
  const { toast, toastError } = useToast();

  if (!invitations || invitations.length === 0) return null;

  const accept = async (id: string) => {
    try {
      await invitationService.accept(id);
      toast("Invitation accepted");
      onAction();
    } catch (e) {
      toastError(errorMessage(e, "Failed to accept invitation"));
    }
  };

  const decline = async (id: string) => {
    try {
      await invitationService.decline(id);
      toast("Invitation declined");
      onAction();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Failed to decline invitation");
    }
  };

  return (
    <div className="section">
      <h2>Pending Invitations</h2>
      <div className="card">
        {invitations.map((inv) => (
          <div key={inv.id} className="invitation-item">
            <div>
              <strong>{inv.tenantName}</strong>
              <br />
              <span className="text-dim text-sm">
                from {inv.inviterDisplayName || inv.inviterHandle}
              </span>
            </div>
            <div className="btn-group">
              <button className="btn-sm" onClick={() => accept(inv.id)}>
                Accept
              </button>
              <button className="btn-sm btn-ghost" onClick={() => decline(inv.id)}>
                Decline
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SetupWizard({ tenant }: { tenant: Tenant }) {
  const { wizardStep, setWizardStep, dismissWizard } = useApp();

  return (
    <div className="wizard-overlay">
      <div className="wizard-card">
        <h2>Welcome to {tenant.name}</h2>
        {wizardStep === 1 && (
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
              tailscale up --login-server https://{tenant.slug}.ts.localhost --authkey YOUR_KEY
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
