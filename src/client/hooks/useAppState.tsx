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
}

interface AppContext extends AppState {
  setTab: (tab: TabId) => void;
  setWizardStep: (step: number) => void;
  dismissWizard: () => void;
  reload: () => Promise<void>;
  reloadRoles: () => Promise<void>;
  reloadSettings: () => Promise<void>;
  isOriginator: () => boolean;
  hasPerm: (perm: string) => boolean;
}

const Ctx = createContext<AppContext>(null!);

export function useApp() {
  return useContext(Ctx);
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>({
    user: null,
    tenants: [],
    invitations: [],
    currentTenant: null,
    tab: "devices",
    settings: null,
    roles: [],
    allPerms: [],
    stats: null,
    showWizard: false,
    wizardStep: 1,
    wizardDismissed: false,
    loading: true,
  });

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  const init = useCallback(async () => {
    const user = await api<User>("/api/me");
    if (!user) {
      setState((s) => ({ ...s, user: null, loading: false }));
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
      const detail = await api<Tenant>(`/api/tenants/${tenants[0].id}`);
      currentTenant = detail ?? tenants[0];

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
        stats &&
        stats.totalDevices === 0
      ) {
        showWizard = true;
      }
    }

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
    }));

    if (tenants.some((t) => t.status === "provisioning")) {
      if (!pollRef.current) {
        pollRef.current = setInterval(init, 3000);
      }
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
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
    const hash = window.location.hash.slice(1) as TabId;
    if (hash) setState((s) => ({ ...s, tab: hash }));
  }, []);

  const setWizardStep = useCallback((step: number) => {
    setState((s) => ({ ...s, wizardStep: step }));
  }, []);

  const dismissWizard = useCallback(() => {
    setState((s) => ({
      ...s,
      showWizard: false,
      wizardDismissed: true,
    }));
  }, []);

  const reload = useCallback(async () => {
    await init();
  }, [init]);

  const currentTenantIdRef = useRef(state.currentTenant?.id);
  currentTenantIdRef.current = state.currentTenant?.id;

  const reloadRoles = useCallback(async () => {
    const tenantId = currentTenantIdRef.current;
    if (!tenantId) return;
    const roles =
      (await rolesService.getRoles(tenantId)) ?? [];
    setState((s) => ({ ...s, roles }));
  }, []);

  const reloadSettings = useCallback(async () => {
    const tenantId = currentTenantIdRef.current;
    if (!tenantId) return;
    const settings = await securityService.getSettings(tenantId);
    setState((s) => ({ ...s, settings }));
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

  const ctx: AppContext = {
    ...state,
    setTab,
    setWizardStep,
    dismissWizard,
    reload,
    reloadRoles,
    reloadSettings,
    isOriginator,
    hasPerm,
  };

  return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>;
}
