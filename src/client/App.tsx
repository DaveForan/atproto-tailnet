import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useSession } from "./hooks/session";
import { useTabRoute } from "./hooks/useTabRoute";
import { useWizard } from "./hooks/useWizard";
import { Header, LockdownBanner, LoginPage, Sidebar, SidebarProvider } from "./components/Layout";
import { AttentionProvider } from "./hooks/useAttention";
import { Loading } from "./components/Loading";
import { InvitePage, NoAccessPage, SuspendedPage } from "./components/AccessPages";
import { DeviceSignInPage } from "./components/DeviceSignIn";
import { VerifyDevicePage } from "./components/VerifyDevice";
import { SetupWizard } from "./components/SetupWizard";
import { pageSections, tabRegistry } from "./components/registry";
import { usePathRoute } from "./hooks/usePathRoute";
import type { TabId } from "./lib/types";
import { onSessionExpired, SESSION_EXPIRED_MESSAGE } from "./services/api";

const lazyTab = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) =>
  lazy(() => load().then((m) => ({ default: m[name] })));

const AccountTab = lazy(() => import("./tabs/AccountTab").then((m) => ({ default: m.AccountTab })));

const tabComponents: Record<TabId, React.LazyExoticComponent<React.ComponentType>> = {
  overview: lazyTab(() => import("./tabs/OverviewTab"), "OverviewTab"),
  devices: lazyTab(() => import("./tabs/DevicesTab"), "DevicesTab"),
  people: lazyTab(() => import("./tabs/PeopleTab"), "PeopleTab"),
  board: lazyTab(() => import("./tabs/BoardsTab"), "BoardsTab"),
  sharing: lazyTab(() => import("./tabs/SharingTab"), "SharingTab"),
  settings: lazyTab(() => import("./tabs/SettingsTab"), "SettingsTab"),
  account: lazyTab(() => import("./tabs/AccountTab"), "AccountPage"),
  instance: lazyTab(() => import("./tabs/InstanceTab"), "InstanceTab"),
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
  const { currentTenant } = useSession();
  const { tab, section, setTab, navCount } = useTabRoute();
  const TabComponent = tabComponents[tab] ?? tabComponents.overview;
  const label = tabRegistry.find((e) => e.id === tab)?.label ?? "Overview";
  const sectionLabel = pageSections[tab]?.find((s) => s.id === section)?.label;
  const title = sectionLabel ? `${label}: ${sectionLabel}` : label;
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    document.title = currentTenant ? `${title} · ${currentTenant.name} · ${APP_NAME}` : APP_NAME;
  }, [title, currentTenant?.name]);

  // Screen readers and keyboard users land on the new page; the first load keeps the browser's focus
  useEffect(() => {
    if (navCount > 0) headingRef.current?.focus();
  }, [navCount]);

  return (
    <AttentionProvider>
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
          <Suspense key={currentTenant?.id} fallback={<Loading />}>
            <TabComponent />
          </Suspense>
        </main>
      </div>
    </AttentionProvider>
  );
}
