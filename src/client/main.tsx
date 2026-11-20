import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider } from "./hooks/useAppState";
import { ToastProvider } from "./components/Toast";
import { ConfirmProvider } from "./components/ConfirmDialog";
import { App } from "./App";
import { applyTheme } from "./lib/theme";

applyTheme();

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <AppProvider>
      <ToastProvider>
        <ConfirmProvider>
          <App />
        </ConfirmProvider>
      </ToastProvider>
    </AppProvider>
  </StrictMode>,
);
