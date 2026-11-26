import { useEffect, useState } from "react";
import { useSession } from "../hooks/session";
import { useWizard } from "../hooks/useWizard";
import { useToast } from "./Toast";
import { CodeBlock } from "./CodeBlock";
import { AddressForm } from "./TailnetAddress";
import { hostnamesService } from "../services/hostnames";
import type { HostnamesData, Tenant } from "../lib/types";

/** First-run wizard: choose the tailnet address (originator), install Tailscale, connect a device. */
export function SetupWizard({ tenant }: { tenant: Tenant }) {
  const { reloadTenants } = useSession();
  const { toastFailure } = useToast();
  const { wizardStep, setWizardStep, dismissWizard } = useWizard();
  const [address, setAddress] = useState<HostnamesData | null>(null);

  useEffect(() => {
    let stale = false;
    hostnamesService
      .list(tenant.id)
      .then((d) => { if (!stale && d) setAddress(d); })
      .catch((e: unknown) => {
        if (stale) return;
        setAddress(null);
        toastFailure(e, "Could not load the tailnet address");
      });
    return () => { stale = true; };
  }, [tenant.id, toastFailure]);

  const loginServer = address?.loginServer ?? "https://<login-server>";

  return (
    <main className="wizard-overlay">
      <div className="wizard-card">
        <p className="wizard-step" aria-live="polite">Step {wizardStep} of 3</p>
        <h2>Welcome to {tenant.name}</h2>
        {wizardStep === 1 && tenant.isOriginator && address && (
          <div>
            <p>
              Your tailnet is ready. First, choose its address — the public name used in
              join and board links{address.sharedControl ? "" : ", and the server your devices connect to"}.
              You can change it later; old addresses keep working as aliases.
            </p>
            <AddressForm
              tenantId={tenant.id}
              initial={address.primary}
              baseDomain={address.baseDomain}
              sharedControl={address.sharedControl}
              submitLabel="Use this address"
              onSaved={(primary) => {
                setAddress({ ...address, primary });
                void reloadTenants();
                setWizardStep(2);
              }}
              secondary={
                <button type="button" className="btn-ghost" onClick={() => setWizardStep(2)}>
                  Keep {address.primary}
                </button>
              }
            />
          </div>
        )}
        {wizardStep === 1 && !(tenant.isOriginator && address) && (
          <div>
            <p>Your tailnet is ready. Let&apos;s connect your first device.</p>
            <div className="wizard-actions">
              <button type="button" onClick={() => setWizardStep(2)}>Get started</button>
              <button type="button" className="btn-ghost" onClick={dismissWizard}>
                Skip
              </button>
            </div>
          </div>
        )}
        {wizardStep === 2 && (
          <div>
            <p>
              Install <a href="https://tailscale.com/download" target="_blank" rel="noopener noreferrer">Tailscale</a> on your device, then open <strong>Devices</strong> to generate an auth key.
            </p>
            <div className="wizard-actions">
              <button type="button" onClick={() => setWizardStep(3)}>Next</button>
              <button type="button" className="btn-ghost" onClick={() => setWizardStep(1)}>Back</button>
            </div>
          </div>
        )}
        {wizardStep === 3 && (
          <div>
            <p>Run this command with your auth key:</p>
            <CodeBlock value={`tailscale up --login-server ${loginServer} --authkey YOUR_KEY`} label="Connect command" />
            <div className="wizard-actions">
              <button type="button" onClick={dismissWizard}>Go to the dashboard</button>
              <button type="button" className="btn-ghost" onClick={() => setWizardStep(2)}>Back</button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
