import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { parseRoute, routeHash, tabEnabled, tabRegistry, visibleSections, type Route } from "../components/registry";
import { useSession } from "./session";
import type { TabId } from "../lib/types";

interface RouteContext {
  tab: TabId;
  /** The open sub-view of the page; null means its first one. */
  section: string | null;
  setTab: (tab: TabId, section?: string | null) => void;
  /** Counts page changes the user asked for; the permission fallback does not count. */
  navCount: number;
}

const RouteCtx = createContext<RouteContext>(null!);

/** The open page, kept in the URL hash. */
export function useTabRoute() {
  return useContext(RouteCtx);
}

const HOME: Route = { tab: "overview", section: null };

function currentRoute(): Route {
  return parseRoute(window.location.hash.slice(1)) ?? HOME;
}

function replaceHash(route: Route) {
  history.replaceState(null, "", `${location.pathname}${location.search}#${routeHash(route)}`);
}

export function TabRouteProvider({ children }: { children: ReactNode }) {
  const { loading, currentTenant, settings, user, hasPerm } = useSession();
  const [route, setRoute] = useState<Route>(currentRoute);
  const [navCount, setNavCount] = useState(0);

  // Mirrors `route` for the hashchange handler, which must not count a change it already knows
  const routeRef = useRef(route);
  routeRef.current = route;

  const setTab = useCallback((tab: TabId, section: string | null = null) => {
    const next = { tab, section };
    routeRef.current = next;
    setRoute(next);
    setNavCount((n) => n + 1);
    window.location.hash = routeHash(next);
  }, []);

  useEffect(() => {
    const onHash = () => {
      if (!window.location.hash.slice(1)) return;
      const next = currentRoute();
      const prev = routeRef.current;
      if (prev.tab === next.tab && prev.section === next.section) return;
      setRoute(next);
      setNavCount((n) => n + 1);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // A page this user may not open falls back to Overview, a section to the first one of its page
  useEffect(() => {
    if (loading || !currentTenant) return;
    const entry = tabRegistry.find((e) => e.id === route.tab);
    if (!entry || !tabEnabled(entry, hasPerm, settings, currentTenant, user)) {
      setRoute(HOME);
      if (window.location.hash) replaceHash(HOME);
      return;
    }
    if (route.section === null) return;
    const sections = visibleSections(route.tab, hasPerm, settings, currentTenant, user);
    if (!sections.some((s) => s.id === route.section)) {
      const next = { tab: route.tab, section: null };
      setRoute(next);
      replaceHash(next);
    }
  }, [loading, route, currentTenant, settings, user, hasPerm]);

  const value = useMemo(
    () => ({ tab: route.tab, section: route.section, setTab, navCount }),
    [route, setTab, navCount],
  );
  return <RouteCtx.Provider value={value}>{children}</RouteCtx.Provider>;
}
