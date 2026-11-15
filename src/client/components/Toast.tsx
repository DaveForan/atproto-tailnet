import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

interface ToastItem {
  id: number;
  message: string;
  variant: "info" | "error";
}

interface ToastCtx {
  toast: (message: string) => void;
  toastError: (message: string) => void;
}

const Ctx = createContext<ToastCtx>(null!);

export function useToast() {
  return useContext(Ctx);
}

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const add = useCallback((message: string, variant: "info" | "error") => {
    const id = nextId++;
    setItems((prev) => [...prev, { id, message, variant }]);
    setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id));
    }, 3000);
  }, []);

  const toast = useCallback((msg: string) => add(msg, "info"), [add]);
  const toastError = useCallback((msg: string) => add(msg, "error"), [add]);

  return (
    <Ctx.Provider value={{ toast, toastError }}>
      {children}
      <div className="toast-container">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.variant}`}>
            {t.message}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
