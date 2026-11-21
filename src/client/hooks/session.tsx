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
import { errorCode, errorMessage } from "../lib/utils";
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
  reloadAndSelect: (tenantId: string) => Promise<void>;
  reloadRoles: () => Promise<void>;
  reloadSettings: () => Promise<void>;
  /** Pending invitations only. */
  reloadInvitations: () => Promise<void>;
  /** The tailnet list, the selected tailnet's details and its stats. */
  reloadTenants: () => Promise<void>;
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
  } catch { /* storage blocked: the next visit does not remember the choice */ }
}

/** `prev` when `next` has the same fields, so context consumers do not re-render for an equal object. */
function keepIfEqual<T extends object>(prev: T | null, next: T | null): T | null {
  if (!prev || !next) return next;
  const a = prev as Record<string, unknown>;
  const b = next as Record<string, unknown>;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return next;
  return keys.every((k) => Object.is(a[k], b[k])) ? prev : next;
}

/** The selected tailnet with its details; a suspended tailnet answers 403 `tenant_suspended` to non-operators. */
async function loadTenantDetail(selected: Tenant, user: User): Promise<Tenant> {
  let suspended = !!selected.suspended;
  let detail: Tenant | null = null;
  if (!suspended || user.isOperator) {
    detail = await sessionService.tenant(selected.id).catch((e: unknown) => {
      if (errorCode(e) !== "tenant_suspended") throw e;
      suspended = true;
      return null;
    });
  }
  return { ...selected, ...detail, suspended: detail?.suspended ?? suspended };
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
  const preferTenantRef = useRef<string | null>(null);

  const userRef = useRef<User | null>(null);
  userRef.current = state.user;
  // The interval outlives renders, so it calls the latest reloadTenants through this ref
  const reloadTenantsRef = useRef<() => Promise<void>>(async () => {});

  /** Polls while any tailnet is provisioning. */
  const updatePoll = useCallback((tenants: Tenant[]) => {
    if (tenants.some((t) => t.status === "provisioning")) {
      pollRef.current ??= setInterval(() => { void reloadTenantsRef.current(); }, 3000);
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

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
        const preferred = preferTenantRef.current
          ? tenants.find((t) => t.id === preferTenantRef.current)
          : undefined;
        preferTenantRef.current = null;
        const selected =
          preferred ?? tenants.find((t) => t.id === selectedTenantRef.current) ?? tenants[0];
        selectedTenantRef.current = selected.id;
        currentTenant = await loadTenantDetail(selected, user);
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

      setState((s) => ({
        user,
        tenants,
        invitations,
        currentTenant: keepIfEqual(s.currentTenant, currentTenant),
        settings: keepIfEqual(s.settings, settings),
        roles,
        allPerms,
        stats: keepIfEqual(s.stats, stats),
        loading: false,
        error: null,
      }));
      updatePoll(tenants);
    } catch (e) {
      if (seq !== initSeqRef.current) return;
      const message = errorMessage(e, "Failed to load dashboard");
      setState((s) => ({
        ...s,
        loading: false,
        error: silent && !s.loading ? s.error : message,
      }));
    }
  }, [updatePoll]);

  useEffect(() => {
    void init();
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

  const reloadAndSelect = useCallback(async (tenantId: string) => {
    preferTenantRef.current = tenantId;
    await init();
  }, [init]);

  const currentTenantIdRef = useRef(state.currentTenant?.id);
  currentTenantIdRef.current = state.currentTenant?.id;
  const currentSuspendedRef = useRef(state.currentTenant?.suspended);
  currentSuspendedRef.current = state.currentTenant?.suspended;

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

  const reloadInvitations = useCallback(async () => {
    const seq = initSeqRef.current;
    try {
      const invitations = await sessionService.invitations();
      if (seq === initSeqRef.current) setState((s) => ({ ...s, invitations }));
    } catch { /* a refresh failure keeps the shown list */ }
  }, []);

  const reloadTenants = useCallback(async () => {
    const seq = initSeqRef.current;
    const user = userRef.current;
    const tenantId = selectedTenantRef.current;
    if (!user) return;
    try {
      const tenants = await sessionService.tenants();
      const selected = tenants.find((t) => t.id === tenantId);
      const tenant = selected ? await loadTenantDetail(selected, user) : null;
      // The selection is gone or its suspension changed: settings and roles need the full load
      if (!tenant || !!tenant.suspended !== !!currentSuspendedRef.current) {
        if (seq === initSeqRef.current) await init(true);
        return;
      }
      const stats = !tenant.suspended || user.isOperator ? await deviceService.getStats(tenant.id) : null;
      if (seq !== initSeqRef.current || tenantId !== selectedTenantRef.current) return;
      setState((s) => ({
        ...s,
        tenants,
        currentTenant: keepIfEqual(s.currentTenant, tenant),
        stats: keepIfEqual(s.stats, stats),
      }));
      updatePoll(tenants);
    } catch { /* a refresh failure keeps the shown state */ }
  }, [init, updatePoll]);
  reloadTenantsRef.current = reloadTenants;

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
      reloadInvitations,
      reloadTenants,
      hasPerm,
    }),
    [state, selectTenant, reload, reloadAndSelect, reloadRoles, reloadSettings, reloadInvitations, reloadTenants, hasPerm],
  );
  const tenantValue = useMemo(() => ({ currentTenant: state.currentTenant }), [state.currentTenant]);

  return (
    <SessionCtx.Provider value={value}>
      <TenantCtx.Provider value={tenantValue}>{children}</TenantCtx.Provider>
    </SessionCtx.Provider>
  );
}
