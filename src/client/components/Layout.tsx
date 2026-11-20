import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useApp } from "../hooks/useAppState";
import { securityService } from "../services/security";
import { useToast } from "./Toast";
import { Badge } from "./Badge";
import { BoardText } from "./BoardText";
import { boardsService } from "../services/boards";
import { NotificationBell } from "./NotificationBell";
import { tabEnabled, tabRegistry, type TabGroup } from "./registry";

function safeUrl(url?: string): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    if (u.protocol === "https:" || u.protocol === "http:") return url;
  } catch { /* ignore */ }
  return "";
}

// Sidebar open/close state shared between Header and Sidebar
interface SidebarState {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  closeSidebar: () => void;
}

const SidebarCtx = createContext<SidebarState>({
  sidebarOpen: false,
  toggleSidebar: () => {},
  closeSidebar: () => {},
});

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const toggleSidebar = useCallback(() => setSidebarOpen((v) => !v), []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  return (
    <SidebarCtx.Provider value={{ sidebarOpen, toggleSidebar, closeSidebar }}>
      {children}
    </SidebarCtx.Provider>
  );
}

export function Header({ minimal = false }: { minimal?: boolean }) {
  const { user } = useApp();
  const { toggleSidebar, sidebarOpen } = useContext(SidebarCtx);
  if (!user) return null;
  const avatar = safeUrl(user.avatarUrl);
  return (
    <header>
      <div className="header-left">
        {!minimal && (
          <button
            type="button"
            id="nav-toggle"
            className="hamburger-btn"
            onClick={toggleSidebar}
            aria-label="Menu"
            aria-expanded={sidebarOpen}
            aria-controls="sidebar"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
        )}
        <h1>atproto-tailnet</h1>
      </div>
      <div className="user-info">
        {!minimal && <NotificationBell />}
        {avatar && <img src={avatar} alt="" />}
        <span className="user-handle" title={user.handle}>{user.handle}</span>
        <form action="/auth/logout" method="post" className="inline-block">
          <button className="btn-sm btn-ghost" type="submit">
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}

export function Sidebar() {
  const { currentTenant, tenants, selectTenant, tab, setTab, hasPerm, settings, user } = useApp();
  const { sidebarOpen, closeSidebar } = useContext(SidebarCtx);
  const t = currentTenant;
  const closeRef = useRef<HTMLButtonElement>(null);

  // Drawer behaviour (phones and small tablets): Escape closes it, focus moves
  // into it when it opens and back to the menu button when it closes.
  useEffect(() => {
    if (!sidebarOpen) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeSidebar();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const toggle = document.getElementById("nav-toggle");
      // The drawer is hidden now: never leave focus inside it
      if (toggle && document.getElementById("sidebar")?.contains(document.activeElement)) toggle.focus();
    };
  }, [sidebarOpen, closeSidebar]);

  if (!t) return null;

  const handleTabClick = (tabId: string) => {
    setTab(tabId as import("../lib/types").TabId);
    closeSidebar();
  };

  const groups = buildVisibleGroups(hasPerm, settings, currentTenant, user);
  const roleBadge = t.isOriginator ? (
    <Badge variant="originator">originator</Badge>
  ) : (
    <Badge variant="role">{t.roleName || "citizen"}</Badge>
  );

  return (
    <>
      <aside id="sidebar" className={`sidebar${sidebarOpen ? " open" : ""}`}>
        <div className="sidebar-drawer-head">
          <span>Menu</span>
          <button ref={closeRef} type="button" className="btn-sm btn-ghost" onClick={closeSidebar}>
            Close
          </button>
        </div>
        <div className="sidebar-tenant">
          {tenants.length > 1 ? (
            <select
              aria-label="Select tailnet"
              value={t.id}
              onChange={(e) => {
                selectTenant(e.target.value);
                closeSidebar();
              }}
            >
              {tenants.map((tn) => (
                <option key={tn.id} value={tn.id}>
                  {tn.name}
                </option>
              ))}
            </select>
          ) : (
            <h3>{t.name}</h3>
          )}
          <div className="sidebar-badges">
            <Badge variant={t.status === "running" ? "running" : "stopped"}>
              {t.status}
            </Badge>
            {roleBadge}
          </div>
        </div>
        <nav aria-label="Tailnet pages">
          {groups.map((group) => (
            <div key={group.label} role="group" aria-label={group.label}>
              <div className="nav-group-header" aria-hidden="true">{group.label}</div>
              {group.tabs.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={`nav-item${tab === entry.id ? " active" : ""}`}
                  aria-current={tab === entry.id ? "page" : undefined}
                  onClick={() => handleTabClick(entry.id)}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <div
        className={`sidebar-overlay${sidebarOpen ? " open" : ""}`}
        onClick={closeSidebar}
        aria-hidden="true"
      />
    </>
  );
}

interface VisibleGroup {
  label: string;
  tabs: Array<{ id: string; label: string }>;
}

function buildVisibleGroups(
  hasPerm: (p: string) => boolean,
  settings: import("../lib/types").Settings | null,
  tenant: import("../lib/types").Tenant | null,
  user: import("../lib/types").User | null,
): VisibleGroup[] {
  const result: VisibleGroup[] = [];
  const groupMap = new Map<string, TabGroup>();

  for (const entry of tabRegistry) {
    if (!tabEnabled(entry, hasPerm, settings, tenant, user)) continue;
    if (!groupMap.has(entry.group)) {
      groupMap.set(entry.group, { label: entry.group, tabs: [] });
    }
    groupMap.get(entry.group)!.tabs.push(entry);
  }

  for (const group of groupMap.values()) {
    if (group.tabs.length > 0) result.push(group);
  }

  return result;
}

export function LockdownBanner() {
  const { settings, hasPerm, currentTenant, reloadSettings } = useApp();
  const { toast, toastError } = useToast();
  const [busy, setBusy] = useState(false);
  if (!settings?.lockdownMode) return null;

  const handleDisable = async () => {
    if (!currentTenant || busy) return;
    setBusy(true);
    try {
      await securityService.updateSetting(currentTenant.id, "lockdownMode", false);
      toast("Lockdown mode disabled");
      await reloadSettings();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Failed to disable lockdown mode");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lockdown-banner" role="status">
      <span>
        <strong>Lockdown mode is on.</strong> No new invitations, joins or device registrations are
        permitted.
      </span>
      {hasPerm("manage_settings") && (
        <button type="button" className="btn-sm btn-warning" onClick={handleDisable} disabled={busy}>
          {busy ? "Turning off…" : "Turn off lockdown"}
        </button>
      )}
    </div>
  );
}

export function LoginPage({ redirect, purpose }: { redirect?: string; purpose?: "invite" | "device" }) {
  // The default tailnet's controller board: public text written by its originator
  const [board, setBoard] = useState<{ name: string | null; text: string } | null>(null);
  useEffect(() => {
    boardsService
      .landing()
      .then((b) => setBoard(b))
      .catch(() => setBoard(null));
  }, []);

  return (
    <div id="login-page">
      <h1>atproto-tailnet</h1>
      <p>
        {purpose === "device"
          ? "Sign in with your Bluesky identity to add this device to your tailnet."
          : redirect
          ? "Sign in with your Bluesky identity to view your invitation."
          : "Private mesh networks for your Bluesky identity. Access is by invitation."}
      </p>
      <form action="/auth/login" method="get">
        <input
          type="text"
          name="handle"
          placeholder="yourname.bsky.social"
          aria-label="Bluesky handle"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="username"
          required
        />
        {redirect && <input type="hidden" name="redirect" value={redirect} />}
        <button type="submit">Sign in</button>
      </form>
      {!redirect && board?.text && (
        <section className="landing-board" aria-label={board.name ? `About ${board.name}` : "About this tailnet"}>
          {board.name && <h2>{board.name}</h2>}
          <BoardText text={board.text} />
        </section>
      )}
    </div>
  );
}

export function StatsSummary() {
  const { stats } = useApp();
  if (!stats) return null;
  return (
    <div className="stats-row" role="group" aria-label="Tailnet summary">
      <div className="stat-card">
        <div className="stat-value">{stats.totalDevices}</div>
        <div className="stat-label">Devices</div>
      </div>
      <div className="stat-card">
        <div className="stat-value">{stats.onlineDevices}</div>
        <div className="stat-label">Online</div>
      </div>
    </div>
  );
}
