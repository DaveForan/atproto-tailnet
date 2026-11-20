import { useCallback, useEffect, useRef, useState, type DependencyList } from "react";
import { useTenant } from "./session";
import { errorMessage } from "../lib/utils";

export interface TenantDataResult<T> {
  data: T;
  loading: boolean;
  /** Why the last load failed (the data keeps its previous value), or null. */
  error: string | null;
  reload: () => Promise<void>;
}

/** Loads a service call for the current tenant; reloads when the tenant or `deps` change. */
export type TenantLoader<T> = (tenantId: string) => Promise<T | null>;

export function useTenantData<T>(
  loader: TenantLoader<T>,
  fallback: T,
  deps: DependencyList = [],
): TenantDataResult<T> {
  const { currentTenant } = useTenant();
  const [data, setData] = useState<T>(fallback);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const tenantIdRef = useRef(currentTenant?.id);
  tenantIdRef.current = currentTenant?.id;
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    if (!currentTenant) return;
    const tid = currentTenant.id;
    const seq = ++seqRef.current;
    const isCurrent = () => seq === seqRef.current && tid === tenantIdRef.current;
    setLoading(true);
    try {
      const result = await loaderRef.current(tid);
      if (!isCurrent()) return;
      if (result !== null) setData(result);
      setError(null);
    } catch (e) {
      if (isCurrent()) setError(errorMessage(e, "Could not load this page"));
    } finally {
      if (isCurrent()) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTenant?.id, ...deps]);

  useEffect(() => { void load(); }, [load]);

  return { data, loading, error, reload: load };
}

export type TenantLoaders<T> = { [K in keyof T]: TenantLoader<T[K]> };

/** Loads several service calls at once; one failure does not hide the parts that loaded. */
export function useTenantParallel<T extends object>(
  loaders: TenantLoaders<T>,
  fallback: T,
): TenantDataResult<T> {
  const { currentTenant } = useTenant();
  const [data, setData] = useState<T>(fallback);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const tenantIdRef = useRef(currentTenant?.id);
  tenantIdRef.current = currentTenant?.id;
  const loadersRef = useRef(loaders);
  loadersRef.current = loaders;
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    if (!currentTenant) return;
    const tid = currentTenant.id;
    const seq = ++seqRef.current;
    const isCurrent = () => seq === seqRef.current && tid === tenantIdRef.current;
    setLoading(true);
    try {
      const keys = Object.keys(loadersRef.current) as Array<keyof T>;
      const results = await Promise.allSettled(keys.map((k) => loadersRef.current[k](tid)));
      if (!isCurrent()) return;
      const merged = { ...fallback };
      let failure: unknown = null;
      keys.forEach((k, i) => {
        const r = results[i];
        if (r.status === "rejected") failure ??= r.reason;
        else if (r.value !== null) merged[k] = r.value;
      });
      setData(merged);
      setError(failure ? errorMessage(failure, "Could not load this page") : null);
    } finally {
      if (isCurrent()) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTenant?.id]);

  useEffect(() => { void load(); }, [load]);

  return { data, loading, error, reload: load };
}
