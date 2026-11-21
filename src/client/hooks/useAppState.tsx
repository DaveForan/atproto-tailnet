import type { ReactNode } from "react";
import { SessionProvider } from "./session";
import { TabRouteProvider } from "./useTabRoute";
import { WizardProvider } from "./useWizard";

export function AppProvider({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <TabRouteProvider>
        <WizardProvider>{children}</WizardProvider>
      </TabRouteProvider>
    </SessionProvider>
  );
}
