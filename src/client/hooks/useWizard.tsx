import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useSession } from "./session";

interface WizardContext {
  showWizard: boolean;
  wizardStep: number;
  setWizardStep: (step: number) => void;
  dismissWizard: () => void;
}

const WizardCtx = createContext<WizardContext>(null!);

/** First-run setup wizard of a running tailnet without devices. */
export function useWizard() {
  return useContext(WizardCtx);
}

const WIZARD_KEY = "atproto-tailnet:wizardDone";

/** Tailnets whose setup wizard this browser has finished or skipped. */
function wizardDoneFor(tenantId: string): boolean {
  try {
    return (JSON.parse(localStorage.getItem(WIZARD_KEY) ?? "[]") as string[]).includes(tenantId);
  } catch {
    return false;
  }
}

function rememberWizardDone(tenantId: string): void {
  try {
    const done = new Set(JSON.parse(localStorage.getItem(WIZARD_KEY) ?? "[]") as string[]);
    done.add(tenantId);
    localStorage.setItem(WIZARD_KEY, JSON.stringify([...done].slice(-50)));
  } catch {
    // storage blocked: the wizard is dismissed for this page view only
  }
}

export function WizardProvider({ children }: { children: ReactNode }) {
  const { currentTenant, stats } = useSession();
  const [wizardStep, setWizardStep] = useState(1);
  const [dismissed, setDismissed] = useState(false);

  // Stats are loaded only with the tailnet (null while switching), so this follows each load
  const showWizard = useMemo(
    () =>
      !dismissed &&
      !!currentTenant &&
      currentTenant.status === "running" &&
      !currentTenant.suspended &&
      !!stats &&
      stats.totalDevices === 0 &&
      !wizardDoneFor(currentTenant.id),
    [dismissed, currentTenant, stats],
  );

  const currentTenantId = currentTenant?.id;
  const dismissWizard = useCallback(() => {
    if (currentTenantId) rememberWizardDone(currentTenantId);
    setDismissed(true);
  }, [currentTenantId]);

  const value = useMemo(
    () => ({ showWizard, wizardStep, setWizardStep, dismissWizard }),
    [showWizard, wizardStep, dismissWizard],
  );
  return <WizardCtx.Provider value={value}>{children}</WizardCtx.Provider>;
}
