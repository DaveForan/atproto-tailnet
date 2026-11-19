import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { useApp } from "../hooks/useAppState";
import { securityService } from "../services/security";
import { useToast } from "./Toast";
import { Badge } from "./Badge";
import { tabRegistry, type TabGroup } from "./registry";

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

export function Header() {
  const { user } = useApp();
  const { toggleSidebar } = useContext(SidebarCtx);
  if (!user) return null;
  const avatar = safeUrl(user.avatarUrl);
  return (
    <header>
      <div className="header-left">
        <button className="hamburger-btn" onClick={toggleSidebar}>
          &#9776;
        </button>
        <h1>atproto-tailnet</h1>
      </div>
      <div className="user-info">
        {avatar && <img src={avatar} alt="" />}
        <span>{user.handle}</span>
        <form action="/auth/logout" method="post" style={{ display: "inline" }}>
          <button className="btn-sm btn-ghost" type="submit">
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}

export function Sidebar() {
  const { currentTenant, tenants, selectTenant, tab, setTab, hasPerm, settings } = useApp();
  const { sidebarOpen, closeSidebar } = useContext(SidebarCtx);
  const t = currentTenant;
  if (!t) return null;

  const handleTabClick = (tabId: string) => {
    setTab(tabId as import("../lib/types").TabId);
    closeSidebar();
  };

  const groups = buildVisibleGroups(hasPerm, settings, currentTenant);
  const roleBadge = t.isOriginator ? (
    <Badge variant="originator">originator</Badge>
  ) : (
    <Badge variant="role">{t.roleName || "citizen"}</Badge>
  );

  return (
    <>
      <aside id="sidebar" className={`sidebar${sidebarOpen ? " open" : ""}`}>
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
        <nav>
          {groups.map((group) => (
            <div key={group.label}>
              <div className="nav-group-header">{group.label}</div>
              {group.tabs.map((entry) => (
                <button
                  key={entry.id}
                  className={`nav-item${tab === entry.id ? " active" : ""}`}
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
): VisibleGroup[] {
  const result: VisibleGroup[] = [];
  const groupMap = new Map<string, TabGroup>();

  for (const entry of tabRegistry) {
    if (!entry.gate(hasPerm, settings, tenant)) continue;
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
  if (!settings?.lockdownMode) return null;

  const handleDisable = async () => {
    if (!currentTenant) return;
    try {
      await securityService.updateSetting(currentTenant.id, "lockdownMode", false);
      toast("Lockdown mode disabled");
      await reloadSettings();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Failed to disable lockdown mode");
    }
  };

  return (
    <div className="lockdown-banner">
      <span>
        LOCKDOWN MODE &mdash; No new invitations, joins, or device registrations
        permitted.
      </span>
      {hasPerm("manage_settings") && (
        <button className="btn-sm btn-warning" onClick={handleDisable}>Disable</button>
      )}
    </div>
  );
}

export function LoginPage() {
  return (
    <div id="login-page">
      <h1>atproto-tailnet</h1>
      <p>
        Create private mesh networks with your Bluesky identity. Invite anyone
        by their handle.
      </p>
      <form action="/auth/login" method="get">
        <input
          type="text"
          name="handle"
          placeholder="yourname.bsky.social"
          required
        />
        <button type="submit">Sign in</button>
      </form>
    </div>
  );
}

export function StatsSummary() {
  const { stats } = useApp();
  if (!stats) return null;
  return (
    <div className="stats-row">
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
