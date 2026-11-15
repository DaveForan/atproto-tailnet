import { useCallback, useState } from "react";
import { tenantApi } from "../services/api";
import { useApp } from "./useAppState";
import { useToast } from "../components/Toast";

interface MutationOptions {
  onSuccess?: string;
  onError?: string;
  reload?: () => Promise<void>;
}

interface MutateCallOptions {
  successMsg?: string;
  reload?: () => Promise<void>;
}

interface MutationResult {
  mutate: (path: string, opts?: RequestInit, callOpts?: MutateCallOptions) => Promise<boolean>;
  busy: boolean;
}

export function useTenantMutation(options?: MutationOptions): MutationResult {
  const { currentTenant } = useApp();
  const { toast, toastError } = useToast();
  const [busy, setBusy] = useState(false);

  const mutate = useCallback(
    async (path: string, opts?: RequestInit, callOpts?: MutateCallOptions): Promise<boolean> => {
      if (!currentTenant) return false;
      setBusy(true);
      try {
        await tenantApi(currentTenant.id, path, opts);
        const msg = callOpts?.successMsg ?? options?.onSuccess;
        if (msg) toast(msg);
        const reloadFn = callOpts?.reload ?? options?.reload;
        if (reloadFn) await reloadFn();
        return true;
      } catch (e) {
        toastError(
          e instanceof Error
            ? e.message
            : options?.onError ?? "Operation failed",
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [currentTenant?.id, options?.onSuccess, options?.onError, options?.reload],
  );

  return { mutate, busy };
}
