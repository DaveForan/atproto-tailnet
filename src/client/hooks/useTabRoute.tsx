import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { tabEnabled, tabRegistry } from "../components/registry";
import { useSession } from "./session";
import type { TabId } from "../lib/types";

interface RouteContext {
  tab: TabId;
  setTab: (tab: TabId) => void;
  /** Counts tab changes the user asked for; the permission fallback does not count. */
  navCount: number;
}

const RouteCtx = createContext<RouteContext>(null!);

/** The open tab, kept in the URL hash. */
export function useTabRoute() {
  return useContext(RouteCtx);
}

function isTabId(v: string): v is TabId {
  return tabRegistry.some((e) => e.id === v);
}

function initialTab(): TabId {
  const hash = window.location.hash.slice(1);
  if (!hash) return "devices";
  return isTabId(hash) ? hash : "status";
}

export function TabRouteProvider({ children }: { children: ReactNode }) {
  const { loading, currentTenant, settings, user, hasPerm } = useSession();
  const [tab, setTabState] = useState<TabId>(initialTab);
  const [navCount, setNavCount] = useState(0);

  const setTab = useCallback((next: TabId) => {
    setTabState(next);
    setNavCount((n) => n + 1);
    window.location.hash = next;
  }, []);

  useEffect(() => {
    const onHash = () => {
      const hash = window.location.hash.slice(1);
      if (!hash) return;
      setTabState(isTabId(hash) ? hash : "status");
      setNavCount((n) => n + 1);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // A tab this user may not open (permissions, settings, features) falls back to Status
  useEffect(() => {
    if (loading || !currentTenant) return;
    const entry = tabRegistry.find((e) => e.id === tab);
    if (!entry || !tabEnabled(entry, hasPerm, settings, currentTenant, user)) {
      setTabState("status");
      if (window.location.hash) {
        history.replaceState(null, "", `${location.pathname}${location.search}#status`);
      }
    }
  }, [loading, tab, currentTenant, settings, user, hasPerm]);

  const value = useMemo(() => ({ tab, setTab, navCount }), [tab, setTab, navCount]);
  return <RouteCtx.Provider value={value}>{children}</RouteCtx.Provider>;
}
