import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { fetchCsrfToken } from "../services/api";
import { sessionService } from "../services/session";
import { deviceService } from "../services/devices";
import { rolesService } from "../services/roles";
import { securityService } from "../services/security";
import { errorCode } from "../lib/utils";
import type { Invitation, Role, Settings, Stats, Tenant, User } from "../lib/types";

interface SessionState {
  user: User | null;
  tenants: Tenant[];
  invitations: Invitation[];
  currentTenant: Tenant | null;
  settings: Settings | null;
  roles: Role[];
  allPerms: string[];
  stats: Stats | null;
  loading: boolean;
  error: string | null;
}

export interface SessionContext extends SessionState {
  selectTenant: (tenantId: string) => void;
  reload: () => Promise<void>;
  reloadAndSelect: (slug: string) => Promise<void>;
  reloadRoles: () => Promise<void>;
  reloadSettings: () => Promise<void>;
  isOriginator: () => boolean;
  hasPerm: (perm: string) => boolean;
}

const SessionCtx = createContext<SessionContext>(null!);
const TenantCtx = createContext<{ currentTenant: Tenant | null }>({ currentTenant: null });

/** Signed-in user, tailnets, the selected tailnet with its settings and roles. */
export function useSession() {
  return useContext(SessionCtx);
}

/** Only the selected tailnet: does not re-render on other session changes. */
export function useTenant() {
  return useContext(TenantCtx);
}

const TENANT_KEY = "atproto-tailnet:selectedTenant";

function readStoredTenant(): string | null {
  try {
    return localStorage.getItem(TENANT_KEY);
  } catch {
    return null;
  }
}

function storeTenant(tenantId: string): void {
  try {
    localStorage.setItem(TENANT_KEY, tenantId);
  } catch { /* ignore */ }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({
    user: null,
    tenants: [],
    invitations: [],
    currentTenant: null,
    settings: null,
    roles: [],
    allPerms: [],
    stats: null,
    loading: true,
    error: null,
  });

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const selectedTenantRef = useRef<string | null>(readStoredTenant());
  const initSeqRef = useRef(0);
  const preferSlugRef = useRef<string | null>(null);

  const init = useCallback(async (silent = false) => {
    const seq = ++initSeqRef.current;
    try {
      const user = await sessionService.me();
      if (seq !== initSeqRef.current) return;
      if (!user) {
        setState((s) => ({ ...s, user: null, loading: false, error: null }));
        return;
      }

      await fetchCsrfToken();

      const [tenants, invitations, allPerms] = await Promise.all([
        sessionService.tenants(),
        sessionService.invitations(),
        sessionService.permissions(),
      ]);

      let currentTenant: Tenant | null = null;
      let settings: Settings | null = null;
      let roles: Role[] = [];
      let stats: Stats | null = null;

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
          detail = await sessionService.tenant(selected.id).catch((e: unknown) => {
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
          deviceService.getStats(currentTenant.id),
        ]);
        settings = s;
        roles = r;
        stats = st;
      }

      if (seq !== initSeqRef.current) return;

      setState({
        user,
        tenants,
        invitations,
        currentTenant,
        settings,
        roles,
        allPerms,
        stats,
        loading: false,
        error: null,
      });

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
  }, []);

  useEffect(() => {
    init();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [init]);

  const selectTenant = useCallback((tenantId: string) => {
    if (tenantId === selectedTenantRef.current) return;
    selectedTenantRef.current = tenantId;
    storeTenant(tenantId);
    setState((s) => ({
      ...s,
      currentTenant: s.tenants.find((t) => t.id === tenantId) ?? s.currentTenant,
      settings: null,
      roles: [],
      stats: null,
      loading: true,
    }));
    void init();
  }, [init]);

  const reload = useCallback(async () => {
    await init();
  }, [init]);

  const reloadAndSelect = useCallback(async (slug: string) => {
    preferSlugRef.current = slug;
    await init();
  }, [init]);

  const currentTenantIdRef = useRef(state.currentTenant?.id);
  currentTenantIdRef.current = state.currentTenant?.id;

  const reloadRoles = useCallback(async () => {
    const tenantId = currentTenantIdRef.current;
    if (!tenantId) return;
    const roles = (await rolesService.getRoles(tenantId)) ?? [];
    if (tenantId === currentTenantIdRef.current) setState((s) => ({ ...s, roles }));
  }, []);

  const reloadSettings = useCallback(async () => {
    const tenantId = currentTenantIdRef.current;
    if (!tenantId) return;
    const settings = await securityService.getSettings(tenantId);
    if (tenantId === currentTenantIdRef.current) setState((s) => ({ ...s, settings }));
  }, []);

  const isOriginator = useCallback(() => {
    return !!state.currentTenant?.isOriginator;
  }, [state.currentTenant]);

  const hasPerm = useCallback(
    (perm: string) => {
      if (state.currentTenant?.isOriginator) return true;
      const role = state.roles.find((r) => r.id === state.currentTenant?.roleId);
      return role?.permissions.includes(perm) ?? false;
    },
    [state.currentTenant, state.roles],
  );

  const value = useMemo<SessionContext>(
    () => ({
      ...state,
      selectTenant,
      reload,
      reloadAndSelect,
      reloadRoles,
      reloadSettings,
      isOriginator,
      hasPerm,
    }),
    [state, selectTenant, reload, reloadAndSelect, reloadRoles, reloadSettings, isOriginator, hasPerm],
  );
  const tenantValue = useMemo(() => ({ currentTenant: state.currentTenant }), [state.currentTenant]);

  return (
    <SessionCtx.Provider value={value}>
      <TenantCtx.Provider value={tenantValue}>{children}</TenantCtx.Provider>
    </SessionCtx.Provider>
  );
}
