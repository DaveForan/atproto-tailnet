import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { errorMessage } from "../lib/utils";

interface ToastItem {
  id: number;
  message: string;
  variant: "info" | "error";
}

interface ToastCtx {
  toast: (message: string) => void;
  toastError: (message: string) => void;
  /** Error toast for a caught error: its message, or `fallback`. */
  toastFailure: (e: unknown, fallback: string) => void;
}

const Ctx = createContext<ToastCtx>(null!);

export function useToast() {
  return useContext(Ctx);
}

/** An info toast leaves after this long; an error stays until dismissed (WCAG 2.2.1). */
const INFO_MS = 5000;

let nextId = 0;

/**
 * Toasts are shown visually in a stack and announced through two live regions
 * that are mounted once, so screen readers hear each message (a region created
 * together with its text is often not announced).
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const [politeText, setPoliteText] = useState("");
  const [assertiveText, setAssertiveText] = useState("");
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    setItems((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const add = useCallback((message: string, variant: "info" | "error") => {
    const id = nextId++;
    setItems((prev) => [...prev, { id, message, variant }]);
    // Clear, then set, so the same message twice is announced twice
    const announce = variant === "error" ? setAssertiveText : setPoliteText;
    announce("");
    setTimeout(() => announce(message), 50);
    if (variant === "info") timers.current.set(id, setTimeout(() => dismiss(id), INFO_MS));
  }, [dismiss]);

  useEffect(() => {
    const all = timers.current;
    return () => {
      for (const t of all.values()) clearTimeout(t);
    };
  }, []);

  const toast = useCallback((msg: string) => add(msg, "info"), [add]);
  const toastError = useCallback((msg: string) => add(msg, "error"), [add]);
  const toastFailure = useCallback((e: unknown, fallback: string) => add(errorMessage(e, fallback), "error"), [add]);
  const value = useMemo(() => ({ toast, toastError, toastFailure }), [toast, toastError, toastFailure]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{politeText}</div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">{assertiveText}</div>
      <div className="toast-container">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.variant}`}>
            <span className="toast-message">{t.message}</span>
            <button
              type="button"
              className="toast-dismiss"
              aria-label="Dismiss notification"
              onClick={() => dismiss(t.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
