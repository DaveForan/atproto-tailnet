import { useCallback, useEffect, useRef, useState } from "react";
import { tenantApi } from "../services/api";
import { useApp } from "./useAppState";
import { errorMessage } from "../lib/utils";

export interface TenantDataResult<T> {
  data: T;
  loading: boolean;
  /** Why the last load failed (the data keeps its previous value), or null. */
  error: string | null;
  reload: () => Promise<void>;
}

export function useTenantData<T>(
  path: string,
  fallback: T,
): TenantDataResult<T> {
  const { currentTenant } = useApp();
  const [data, setData] = useState<T>(fallback);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const tenantIdRef = useRef(currentTenant?.id);
  tenantIdRef.current = currentTenant?.id;
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    if (!currentTenant) return;
    const tid = currentTenant.id;
    const seq = ++seqRef.current;
    const isCurrent = () => seq === seqRef.current && tid === tenantIdRef.current;
    setLoading(true);
    try {
      const result = await tenantApi<T>(tid, path);
      if (!isCurrent()) return;
      if (result !== null) setData(result);
      setError(null);
    } catch (e) {
      if (isCurrent()) setError(errorMessage(e, "Could not load this page"));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [currentTenant?.id, path]);

  useEffect(() => { void load(); }, [load]);

  return { data, loading, error, reload: load };
}

interface ParallelSpec {
  path: string;
  key: string;
}

export function useTenantParallel<T extends object>(
  specs: ParallelSpec[],
  fallback: T,
): TenantDataResult<T> {
  const { currentTenant } = useApp();
  const [data, setData] = useState<T>(fallback);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const tenantIdRef = useRef(currentTenant?.id);
  tenantIdRef.current = currentTenant?.id;
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    if (!currentTenant) return;
    const tid = currentTenant.id;
    const seq = ++seqRef.current;
    const isCurrent = () => seq === seqRef.current && tid === tenantIdRef.current;
    setLoading(true);
    try {
      // Every part is loaded; one failure does not hide the parts that loaded
      const results = await Promise.allSettled(
        specs.map((s) => tenantApi(tid, s.path)),
      );
      if (!isCurrent()) return;
      const merged = { ...fallback } as Record<string, unknown>;
      let failure: unknown = null;
      specs.forEach((s, i) => {
        const r = results[i];
        if (r.status === "rejected") failure ??= r.reason;
        else if (r.value !== null) merged[s.key] = r.value;
      });
      setData(merged as T);
      setError(failure ? errorMessage(failure, "Could not load this page") : null);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [currentTenant?.id]);

  useEffect(() => { void load(); }, [load]);

  return { data, loading, error, reload: load };
}
