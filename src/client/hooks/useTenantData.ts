import { useCallback, useEffect, useState } from "react";
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

  const load = useCallback(async () => {
    if (!currentTenant) return;
    setLoading(true);
    try {
      const result = await tenantApi<T>(currentTenant.id, path);
      if (result !== null) setData(result);
    } finally {
      setLoading(false);
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

  const load = useCallback(async () => {
    if (!currentTenant) return;
    setLoading(true);
    try {
      const results = await Promise.all(
        specs.map((s) => tenantApi(currentTenant.id, s.path)),
      );
      const merged = { ...fallback } as Record<string, unknown>;
      specs.forEach((s, i) => {
        if (results[i] !== null) merged[s.key] = results[i];
      });
      setData(merged as T);
    } finally {
      setLoading(false);
    }
  }, [currentTenant?.id]);

  useEffect(() => { load(); }, [load]);

  return { data, loading, reload: load };
}
