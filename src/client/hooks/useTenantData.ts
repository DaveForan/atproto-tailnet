import { useCallback, useEffect, useRef, useState } from "react";
import { tenantApi } from "../services/api";
import { useApp } from "./useAppState";

interface TenantDataResult<T> {
  data: T;
  loading: boolean;
  reload: () => Promise<void>;
}

export function useTenantData<T>(
  path: string,
  fallback: T,
): TenantDataResult<T> {
  const { currentTenant } = useApp();
  const [data, setData] = useState<T>(fallback);
  const [loading, setLoading] = useState(true);
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
      if (isCurrent() && result !== null) setData(result);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [currentTenant?.id, path]);

  useEffect(() => { load(); }, [load]);

  return { data, loading, reload: load };
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
      const results = await Promise.all(
        specs.map((s) => tenantApi(tid, s.path)),
      );
      if (!isCurrent()) return;
      const merged = { ...fallback } as Record<string, unknown>;
      specs.forEach((s, i) => {
        if (results[i] !== null) merged[s.key] = results[i];
      });
      setData(merged as T);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [currentTenant?.id]);

  useEffect(() => { load(); }, [load]);

  return { data, loading, reload: load };
}
