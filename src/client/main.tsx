import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider } from "./hooks/useAppState";
import { ToastProvider } from "./components/Toast";
import { App } from "./App";

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <AppProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </AppProvider>
  </StrictMode>,
);
