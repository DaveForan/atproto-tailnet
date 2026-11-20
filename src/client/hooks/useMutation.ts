import { useCallback, useRef, useState } from "react";
import { useTenant } from "./session";
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

/** A service call for the current tenant. */
export type TenantAction = (tenantId: string) => Promise<unknown>;

interface MutationResult {
  mutate: (action: TenantAction, callOpts?: MutateCallOptions) => Promise<boolean>;
  busy: boolean;
}

export function useTenantMutation(options?: MutationOptions): MutationResult {
  const { currentTenant } = useTenant();
  const { toast, toastFailure } = useToast();
  const [busy, setBusy] = useState(false);
  const inFlightRef = useRef(false);

  const mutate = useCallback(
    async (action: TenantAction, callOpts?: MutateCallOptions): Promise<boolean> => {
      if (!currentTenant || inFlightRef.current) return false;
      inFlightRef.current = true;
      setBusy(true);
      try {
        await action(currentTenant.id);
        const msg = callOpts?.successMsg ?? options?.onSuccess;
        if (msg) toast(msg);
        const reloadFn = callOpts?.reload ?? options?.reload;
        if (reloadFn) await reloadFn();
        return true;
      } catch (e) {
        toastFailure(e, options?.onError ?? "Operation failed");
        return false;
      } finally {
        inFlightRef.current = false;
        setBusy(false);
      }
    },
    [currentTenant?.id, options?.onSuccess, options?.onError, options?.reload],
  );

  return { mutate, busy };
}
