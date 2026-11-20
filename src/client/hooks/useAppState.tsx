import { useMemo, type ReactNode } from "react";
import { SessionProvider, useSession } from "./session";
import { TabRouteProvider, useTabRoute } from "./useTabRoute";
import { useWizard, WizardProvider } from "./useWizard";

export function AppProvider({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <TabRouteProvider>
        <WizardProvider>{children}</WizardProvider>
      </TabRouteProvider>
    </SessionProvider>
  );
}

/**
 * Everything at once (session, tab routing, wizard). Re-renders on any of
 * them; prefer `useSession`, `useTenant`, `useTabRoute` or `useWizard`.
 */
export function useApp() {
  const session = useSession();
  const route = useTabRoute();
  const wizard = useWizard();
  return useMemo(() => ({ ...session, ...route, ...wizard }), [session, route, wizard]);
}
