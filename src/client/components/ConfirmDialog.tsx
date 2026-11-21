import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive */
  danger?: boolean;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const Ctx = createContext<ConfirmFn>(async (o) => window.confirm(o.message ? `${o.title}\n\n${o.message}` : o.title));

/** `const confirm = useConfirm(); if (!(await confirm({ title, danger: true }))) return;` */
export function useConfirm(): ConfirmFn {
  return useContext(Ctx);
}

/**
 * The native <dialog> traps focus. Escape and the backdrop cancel.
 * Focus starts on Cancel, so Enter never confirms a destructive action.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const titleId = useId();
  const messageId = useId();

  const confirm = useCallback<ConfirmFn>(
    (o) =>
      new Promise<boolean>((resolve) => {
        resolver.current?.(false);
        resolver.current = resolve;
        setOptions(o);
      }),
    [],
  );

  useEffect(() => {
    const d = dialogRef.current;
    if (options && d && !d.open) d.showModal();
  }, [options]);

  const settle = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    if (dialogRef.current?.open) dialogRef.current.close();
    setOptions(null);
  };

  return (
    <Ctx.Provider value={confirm}>
      {children}
      <dialog
        ref={dialogRef}
        className="confirm-dialog"
        aria-labelledby={titleId}
        aria-describedby={options?.message ? messageId : undefined}
        onCancel={(e) => {
          e.preventDefault();
          settle(false);
        }}
        onClick={(e) => {
          if (e.target === dialogRef.current) settle(false);
        }}
      >
        {options && (
          <>
            <h3 id={titleId}>{options.title}</h3>
            {options.message && <p id={messageId}>{options.message}</p>}
            <div className="btn-group">
              <button type="button" className="btn-ghost" onClick={() => settle(false)}>
                {options.cancelLabel ?? "Cancel"}
              </button>
              <button type="button" className={options.danger ? "btn-danger" : undefined} onClick={() => settle(true)}>
                {options.confirmLabel ?? "Confirm"}
              </button>
            </div>
          </>
        )}
      </dialog>
    </Ctx.Provider>
  );
}
