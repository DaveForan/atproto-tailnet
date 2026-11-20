import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, fetchCsrfToken } from "../services/api";
import { deviceService } from "../services/devices";
import { rolesService } from "../services/roles";
import { securityService } from "../services/security";
import { tabEnabled, tabRegistry } from "../components/registry";
import { errorCode } from "../lib/utils";
import type {
  Invitation,
  Role,
  Settings,
  Stats,
  TabId,
  Tenant,
  User,
} from "../lib/types";

interface AppState {
  user: User | null;
  tenants: Tenant[];
  invitations: Invitation[];
  currentTenant: Tenant | null;
  tab: TabId;
  settings: Settings | null;
  roles: Role[];
  allPerms: string[];
  stats: Stats | null;
  showWizard: boolean;
  wizardStep: number;
  wizardDismissed: boolean;
  loading: boolean;
  error: string | null;
}

interface AppContext extends AppState {
  setTab: (tab: TabId) => void;
  selectTenant: (tenantId: string) => void;
  setWizardStep: (step: number) => void;
  dismissWizard: () => void;
  reload: () => Promise<void>;
  reloadAndSelect: (slug: string) => Promise<void>;
  reloadRoles: () => Promise<void>;
  reloadSettings: () => Promise<void>;
  isOriginator: () => boolean;
  hasPerm: (perm: string) => boolean;
}

const Ctx = createContext<AppContext>(null!);

export function useApp() {
  return useContext(Ctx);
}

const TENANT_KEY = "atproto-tailnet:selectedTenant";

function isTabId(v: string): v is TabId {
  return tabRegistry.some((e) => e.id === v);
}

function initialTab(): TabId {
  const hash = window.location.hash.slice(1);
  if (!hash) return "devices";
  return isTabId(hash) ? hash : "status";
}

const WIZARD_KEY = "atproto-tailnet:wizardDone";

/** Tailnets whose setup wizard this browser has finished or skipped. */
function wizardDoneFor(tenantId: string): boolean {
  try {
    return (JSON.parse(localStorage.getItem(WIZARD_KEY) ?? "[]") as string[]).includes(tenantId);
  } catch {
    return false;
  }
}

function rememberWizardDone(tenantId: string): void {
  try {
    const done = new Set(JSON.parse(localStorage.getItem(WIZARD_KEY) ?? "[]") as string[]);
    done.add(tenantId);
    localStorage.setItem(WIZARD_KEY, JSON.stringify([...done].slice(-50)));
  } catch {
    // storage blocked: the wizard is dismissed for this page view only
  }
}

function readStoredTenant(): string | null {
  try {
    return localStorage.getItem(TENANT_KEY);
  } catch {
    return null;
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>({
    user: null,
    tenants: [],
    invitations: [],
    currentTenant: null,
    tab: initialTab(),
    settings: null,
    roles: [],
    allPerms: [],
    stats: null,
    showWizard: false,
    wizardStep: 1,
    wizardDismissed: false,
    loading: true,
    error: null,
  });

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const selectedTenantRef = useRef<string | null>(readStoredTenant());
  const initSeqRef = useRef(0);
  const preferSlugRef = useRef<string | null>(null);

  const loadStats = useCallback(
    async (tenantId: string): Promise<Stats | null> => {
      const devices = await deviceService.getDevices(tenantId);
      if (!devices) return null;
      const byUser = devices.byUser || [];
      let total = 0;
      let online = 0;
      for (const group of byUser) {
        for (const d of group.devices) {
          total++;
          if (d.online) online++;
        }
      }
      return {
        totalDevices: total,
        onlineDevices: online,
        totalMembers: byUser.length,
      };
    },
    [],
  );

  const init = useCallback(async (silent = false) => {
    const seq = ++initSeqRef.current;
    try {
      const user = await api<User>("/api/me");
      if (seq !== initSeqRef.current) return;
      if (!user) {
        setState((s) => ({ ...s, user: null, loading: false, error: null }));
        return;
      }

      await fetchCsrfToken();

      const [tenants, invitations, allPerms] = await Promise.all([
        api<Tenant[]>("/api/tenants").then((r) => r ?? []),
        api<Invitation[]>("/api/invitations").then((r) => r ?? []),
        api<string[]>("/api/permissions").then((r) => r ?? []),
      ]);

      let currentTenant: Tenant | null = null;
      let settings: Settings | null = null;
      let roles: Role[] = [];
      let stats: Stats | null = null;
      let showWizard = false;

      if (tenants.length > 0) {
        const preferred = preferSlugRef.current
          ? tenants.find((t) => t.slug === preferSlugRef.current)
          : undefined;
        preferSlugRef.current = null;
        const selected =
          preferred ?? tenants.find((t) => t.id === selectedTenantRef.current) ?? tenants[0];
        selectedTenantRef.current = selected.id;
        let suspended = !!selected.suspended;
        let detail: Tenant | null = null;
        if (!suspended || user.isOperator) {
          detail = await api<Tenant>(`/api/tenants/${selected.id}`).catch((e: unknown) => {
            if (errorCode(e) !== "tenant_suspended") throw e;
            suspended = true;
            return null;
          });
        }
        currentTenant = { ...selected, ...detail, suspended: detail?.suspended ?? suspended };
      }

      if (currentTenant && (!currentTenant.suspended || user.isOperator)) {
        const [s, r, st] = await Promise.all([
          securityService.getSettings(currentTenant.id),
          rolesService.getRoles(currentTenant.id).then((r) => r ?? []),
          loadStats(currentTenant.id),
        ]);
        settings = s;
        roles = r;
        stats = st;

        if (
          currentTenant.status === "running" &&
          !currentTenant.suspended &&
          stats &&
          stats.totalDevices === 0 &&
          !wizardDoneFor(currentTenant.id)
        ) {
          showWizard = true;
        }
      }

      if (seq !== initSeqRef.current) return;

      setState((prev) => ({
        ...prev,
        user,
        tenants,
        invitations,
        currentTenant,
        settings,
        roles,
        allPerms,
        stats,
        showWizard: showWizard && !prev.wizardDismissed,
        loading: false,
        error: null,
      }));

      if (tenants.some((t) => t.status === "provisioning")) {
        if (!pollRef.current) {
          pollRef.current = setInterval(() => { void init(true); }, 3000);
        }
      } else if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch (e) {
      if (seq !== initSeqRef.current) return;
      const message = e instanceof Error ? e.message : "Failed to load dashboard";
      setState((s) => ({
        ...s,
        loading: false,
        error: silent && !s.loading ? s.error : message,
      }));
    }
  }, [loadStats]);

  useEffect(() => {
    init();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [init]);

  const setTab = useCallback((tab: TabId) => {
    setState((s) => ({ ...s, tab }));
    window.location.hash = tab;
  }, []);

  useEffect(() => {
    const onHash = () => {
      const hash = window.location.hash.slice(1);
      if (!hash) return;
      setState((s) => ({ ...s, tab: isTabId(hash) ? hash : "status" }));
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const selectTenant = useCallback((tenantId: string) => {
    if (tenantId === selectedTenantRef.current) return;
    selectedTenantRef.current = tenantId;
    try {
      localStorage.setItem(TENANT_KEY, tenantId);
    } catch { /* ignore */ }
    setState((s) => ({
      ...s,
      currentTenant: s.tenants.find((t) => t.id === tenantId) ?? s.currentTenant,
      settings: null,
      roles: [],
      stats: null,
      showWizard: false,
      loading: true,
    }));
    void init();
  }, [init]);

  const setWizardStep = useCallback((step: number) => {
    setState((s) => ({ ...s, wizardStep: step }));
  }, []);

  const dismissWizard = useCallback(() => {
    setState((s) => {
      if (s.currentTenant) rememberWizardDone(s.currentTenant.id);
      return { ...s, showWizard: false, wizardDismissed: true };
    });
  }, []);

  const reload = useCallback(async () => {
    await init();
  }, [init]);

  const reloadAndSelect = useCallback(async (slug: string) => {
    preferSlugRef.current = slug;
    await init();
  }, [init]);

  const currentTenantIdRef = useRef(state.currentTenant?.id);
  currentTenantIdRef.current = state.currentTenant?.id;
  const reloadIfCurrent = (tenantId: string) => tenantId === currentTenantIdRef.current;

  const reloadRoles = useCallback(async () => {
    const tenantId = currentTenantIdRef.current;
    if (!tenantId) return;
    const roles =
      (await rolesService.getRoles(tenantId)) ?? [];
    if (reloadIfCurrent(tenantId)) setState((s) => ({ ...s, roles }));
  }, []);

  const reloadSettings = useCallback(async () => {
    const tenantId = currentTenantIdRef.current;
    if (!tenantId) return;
    const settings = await securityService.getSettings(tenantId);
    if (reloadIfCurrent(tenantId)) setState((s) => ({ ...s, settings }));
  }, []);

  const isOriginator = useCallback(() => {
    return !!state.currentTenant?.isOriginator;
  }, [state.currentTenant]);

  const hasPerm = useCallback(
    (perm: string) => {
      if (state.currentTenant?.isOriginator) return true;
      const role = state.roles.find(
        (r) => r.id === state.currentTenant?.roleId,
      );
      return role?.permissions.includes(perm) ?? false;
    },
    [state.currentTenant, state.roles],
  );

  useEffect(() => {
    if (state.loading || !state.currentTenant) return;
    const entry = tabRegistry.find((e) => e.id === state.tab);
    if (!entry || !tabEnabled(entry, hasPerm, state.settings, state.currentTenant, state.user)) {
      setState((s) => ({ ...s, tab: "status" }));
      if (window.location.hash) {
        history.replaceState(null, "", `${location.pathname}${location.search}#status`);
      }
    }
  }, [state.loading, state.tab, state.currentTenant, state.settings, state.user, hasPerm]);

  const ctx: AppContext = {
    ...state,
    setTab,
    selectTenant,
    setWizardStep,
    dismissWizard,
    reload,
    reloadAndSelect,
    reloadRoles,
    reloadSettings,
    isOriginator,
    hasPerm,
  };

  return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>;
}
