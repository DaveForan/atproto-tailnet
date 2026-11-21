import { useCallback, useRef, useState } from "react";
import { useTenant } from "./session";
import { useToast } from "../components/Toast";

interface MutationOptions {
  onSuccess?: string;
  /** Error toast text: a fallback for errors without a message, or a function that builds the text. */
  onError?: string | ((e: unknown) => string);
  reload?: () => Promise<void>;
}

interface MutateCallOptions {
  successMsg?: string;
  /** Overrides the hook's `onError` fallback text for this call. */
  errorMsg?: string;
  reload?: () => Promise<void>;
}

/** A service call for the current tenant. */
export type TenantAction = (tenantId: string) => Promise<unknown>;

/** A service call that is not scoped to a tenant (account, instance). */
export type Action = () => Promise<unknown>;

interface MutationResult<A> {
  /** Runs `action` unless one is already running; true when it succeeded. */
  mutate: (action: A, callOpts?: MutateCallOptions) => Promise<boolean>;
  busy: boolean;
}

/** Single-flight runner with success toast, error toast and busy state. */
function useMutationCore(options: MutationOptions | undefined) {
  const { toast, toastError, toastFailure } = useToast();
  const [busy, setBusy] = useState(false);
  const inFlightRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  return {
    busy,
    run: useCallback(
      async (call: Action, callOpts?: MutateCallOptions): Promise<boolean> => {
        if (inFlightRef.current) return false;
        inFlightRef.current = true;
        setBusy(true);
        const opts = optionsRef.current;
        try {
          await call();
          const msg = callOpts?.successMsg ?? opts?.onSuccess;
          if (msg) toast(msg);
          const reloadFn = callOpts?.reload ?? opts?.reload;
          if (reloadFn) await reloadFn();
          return true;
        } catch (e) {
          const onError = callOpts?.errorMsg ?? opts?.onError;
          if (typeof onError === "function") toastError(onError(e));
          else toastFailure(e, onError ?? "Operation failed");
          return false;
        } finally {
          inFlightRef.current = false;
          setBusy(false);
        }
      },
      [toast, toastError, toastFailure],
    ),
  };
}

export function useTenantMutation(options?: MutationOptions): MutationResult<TenantAction> {
  const { currentTenant } = useTenant();
  const { busy, run } = useMutationCore(options);
  const tid = currentTenant?.id;

  const mutate = useCallback(
    async (action: TenantAction, callOpts?: MutateCallOptions): Promise<boolean> => {
      if (!tid) return false;
      return run(() => action(tid), callOpts);
    },
    [tid, run],
  );

  return { mutate, busy };
}

/** `useTenantMutation` for calls outside a tenant (account, instance). */
export function useMutation(options?: MutationOptions): MutationResult<Action> {
  const { busy, run } = useMutationCore(options);
  return { mutate: run, busy };
}
