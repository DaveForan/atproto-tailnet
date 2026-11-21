import { useCallback, useEffect, useRef, useState, type DependencyList } from "react";
import { useTenant } from "./session";
import { errorMessage } from "../lib/utils";

export interface TenantDataResult<T> {
  data: T;
  /** True while a load runs; with `keepPreviousOnReload`, only until the first load ends. */
  loading: boolean;
  /** Why the last load failed (the data keeps its previous value), or null. */
  error: string | null;
  reload: () => Promise<void>;
}

export interface TenantDataOptions {
  /** Reloads keep the current content on screen instead of showing the spinner again. */
  keepPreviousOnReload?: boolean;
  /** The calls are not tenant-scoped: they run without a selected tenant and get "" as the id. */
  instanceWide?: boolean;
}

/** Loads a service call for the current tenant; reloads when the tenant or `deps` change. */
export type TenantLoader<T> = (tenantId: string) => Promise<T | null>;

const LOAD_FAILED = "Could not load this page";

/**
 * Shared load state: a sequence number and the tenant id drop answers that
 * arrive after a newer load or a tenant switch.
 */
function useLoadGuard({ keepPreviousOnReload, instanceWide }: TenantDataOptions) {
  const { currentTenant } = useTenant();
  const tenantId = instanceWide ? "" : currentTenant?.id;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const tenantIdRef = useRef(tenantId);
  tenantIdRef.current = tenantId;
  const seqRef = useRef(0);
  const loadedRef = useRef(false);

  const begin = (tid: string) => {
    const seq = ++seqRef.current;
    if (!keepPreviousOnReload || !loadedRef.current) setLoading(true);
    const isCurrent = () => seq === seqRef.current && tid === tenantIdRef.current;
    const end = () => {
      if (!isCurrent()) return;
      loadedRef.current = true;
      setLoading(false);
    };
    return { isCurrent, end };
  };

  return { tenantId, loading, error, setError, begin };
}

export function useTenantData<T>(
  loader: TenantLoader<T>,
  fallback: T,
  deps: DependencyList = [],
  options: TenantDataOptions = {},
): TenantDataResult<T> {
  const { tenantId, loading, error, setError, begin } = useLoadGuard(options);
  const [data, setData] = useState<T>(fallback);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const load = useCallback(async () => {
    if (tenantId === undefined) return;
    const { isCurrent, end } = begin(tenantId);
    try {
      const result = await loaderRef.current(tenantId);
      if (!isCurrent()) return;
      if (result !== null) setData(result);
      setError(null);
    } catch (e) {
      if (isCurrent()) setError(errorMessage(e, LOAD_FAILED));
    } finally {
      end();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are the caller's loader inputs
  }, [tenantId, ...deps]);

  useEffect(() => { void load(); }, [load]);

  return { data, loading, error, reload: load };
}

export type TenantLoaders<T> = { [K in keyof T]: TenantLoader<T[K]> };

export interface TenantParallelOptions extends TenantDataOptions {
  /** Reload when these change, as well as on a tenant switch. */
  deps?: DependencyList;
}

/** Loads several service calls at once; one failure does not hide the parts that loaded. */
export function useTenantParallel<T extends object>(
  loaders: TenantLoaders<T>,
  fallback: T,
  options: TenantParallelOptions = {},
): TenantDataResult<T> {
  const { tenantId, loading, error, setError, begin } = useLoadGuard(options);
  const [data, setData] = useState<T>(fallback);
  const loadersRef = useRef(loaders);
  loadersRef.current = loaders;

  const load = useCallback(async () => {
    if (tenantId === undefined) return;
    const { isCurrent, end } = begin(tenantId);
    try {
      const keys = Object.keys(loadersRef.current) as Array<keyof T>;
      const results = await Promise.allSettled(keys.map((k) => loadersRef.current[k](tenantId)));
      if (!isCurrent()) return;
      let failure: unknown = null;
      // A part that failed keeps its previous value
      setData((prev) => {
        const merged = { ...prev };
        keys.forEach((k, i) => {
          const r = results[i];
          if (r.status === "fulfilled" && r.value !== null) merged[k] = r.value;
        });
        return merged;
      });
      for (const r of results) if (r.status === "rejected") failure ??= r.reason;
      setError(failure ? errorMessage(failure, LOAD_FAILED) : null);
    } finally {
      end();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are the caller's loader inputs
  }, [tenantId, ...(options.deps ?? [])]);

  useEffect(() => { void load(); }, [load]);

  return { data, loading, error, reload: load };
}
