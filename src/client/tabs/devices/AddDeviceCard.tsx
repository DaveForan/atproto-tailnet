import { useState } from "react";
import { useSession } from "../../hooks/session";
import { useTabRoute } from "../../hooks/useTabRoute";
import { useToast } from "../../components/Toast";
import { Card } from "../../components/Card";
import { CodeBlock } from "../../components/CodeBlock";
import { CopyField } from "../../components/CopyField";
import { useTenantData } from "../../hooks/useTenantData";
import { errorCode, errorMessage } from "../../lib/utils";
import { deviceService } from "../../services/devices";

const EXPIRY_OPTIONS = [1, 24, 24 * 7, 24 * 30];
/** Members without manage_devices get single-use keys of at most 24 hours. */
const MEMBER_EXPIRY_OPTIONS = [1, 24];
const expiryLabel = (h: number) => (h < 24 ? `${h} hour` : h === 24 ? "24 hours" : `${h / 24} days`);

interface IssuedKey {
  command: string;
  reusable: boolean;
  expiresInHours: number;
}

/** The way for most people: sign in on the device itself. No key, no command on phones. */
export function SignInDeviceCard() {
  const { currentTenant } = useSession();
  const { data: loginServer } = useTenantData<string | null>((tid) => deviceService.getLoginServer(tid), null);
  const { data: approval } = useTenantData((tid) => deviceService.ownApproval(tid), null);
  if (!currentTenant?.coordinatorMode) return null;
  const needsApprover = !!approval?.needsApprover;
  return (
    <Card title="Sign in on the device">
      <p className="card-description">
        The easy way for a phone, tablet or computer. You need no key: you sign in with your Bluesky account, the
        same as here.
      </p>
      <ol className="steps">
        <li>
          Install the Tailscale app on the device:{" "}
          <a href="https://tailscale.com/download" target="_blank" rel="noreferrer">tailscale.com/download</a>.
        </li>
        <li>
          Tell the app to use this server. On a phone or tablet, open the account menu of the app and select the
          option for a custom (alternate) server. Then paste this address:
          {loginServer && <CopyField value={loginServer} label="Server address for the Tailscale app" />}
        </li>
        <li>Select <strong>Log in</strong>. A browser page opens: sign in with your Bluesky account.</li>
        <li>
          Check the device name and the key fingerprint on that page and select <strong>Add device</strong>. This
          admits that one device.
        </li>
      </ol>
      {needsApprover && (
        <p className="notice" role="note">
          In this tailnet another member, an approver, must admit each new device too. Your device has no access until then, and
          connects by itself afterwards.
        </p>
      )}
      {loginServer && (
        <>
          <p className="help-text mt-12">On a computer, you can also type this command and open the link that it shows:</p>
          <CodeBlock value={`tailscale login --login-server ${loginServer}`} label="Sign-in command for a computer" />
        </>
      )}
    </Card>
  );
}

/** Issues an auth key; `onIssued` lets the page refresh its list of keys. */
export function AddDeviceCard({ onIssued }: { onIssued?: () => void }) {
  const { currentTenant, hasPerm } = useSession();
  const { setTab } = useTabRoute();
  const canSeeLimits = !!currentTenant?.isOriginator || hasPerm("manage_settings");
  const canManageDevices = hasPerm("manage_devices");
  const expiryOptions = canManageDevices ? EXPIRY_OPTIONS : MEMBER_EXPIRY_OPTIONS;
  const { toast, toastFailure } = useToast();
  const { data: approval } = useTenantData((tid) => deviceService.ownApproval(tid), null);
  // Until the answer is known, say the safer thing: the device waits
  const waits = !!currentTenant?.coordinatorMode && approval?.on !== false;
  const [issued, setIssued] = useState<IssuedKey | null>(null);
  const [pending, setPending] = useState(false);
  const [limitError, setLimitError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [reusable, setReusable] = useState(false);
  const [expiresInHours, setExpiresInHours] = useState(24);

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentTenant || generating) return;
    setGenerating(true);
    setLimitError(null);
    try {
      const opts = canManageDevices
        ? { reusable, expiresInHours }
        : { reusable: false, expiresInHours: Math.min(expiresInHours, 24) };
      const result = await deviceService.generateAuthKey(currentTenant.id, opts);
      if (!result) return;
      if ("approvalId" in result) {
        setIssued(null);
        setPending(true);
        toast("Approval requested");
        return;
      }
      setPending(false);
      setIssued({
        command: result.command || `tailscale up --login-server ${result.loginServer} --authkey ${result.key}`,
        reusable: opts.reusable,
        expiresInHours: opts.expiresInHours,
      });
      toast("Auth key generated");
      onIssued?.();
    } catch (e) {
      if (errorCode(e) === "device_limit") setLimitError(errorMessage(e, ""));
      else toastFailure(e, "Failed to generate auth key");
    } finally {
      setGenerating(false);
    }
  };

  return (
      <Card title="Use a key instead">
        <p className="card-description">
          For a server, a script, or a device with no browser. Generate an auth key and run the command on the
          device.{" "}
          {waits
            ? "A key does not admit a device: after the command, the device waits on Overview until you admit it there."
            : currentTenant?.coordinatorMode &&
              "You turned off the approval of your new devices, so the key alone gives the device access. Keep the key secret."}
        </p>

        <form className="form-stack" onSubmit={handleGenerate}>
          <div className="field-row">
            <div className="field">
              <label htmlFor="key-expiry">Key expires after</label>
              <select
                id="key-expiry"
                value={expiresInHours}
                onChange={(e) => setExpiresInHours(Number(e.target.value))}
              >
                {expiryOptions.map((h) => (
                  <option key={h} value={h}>{expiryLabel(h)}</option>
                ))}
              </select>
            </div>
            {canManageDevices && (
              <label className="check-inline">
                <input
                  type="checkbox"
                  checked={reusable}
                  onChange={(e) => setReusable(e.target.checked)}
                />
                Reusable (connect several devices with one key)
              </label>
            )}
          </div>

          {limitError && (
            <div className="lockdown-banner" role="alert">
              <span>{limitError}</span>
              {canSeeLimits && (
                <button type="button" className="btn-sm btn-ghost" onClick={() => setTab("settings", "limits")}>View limits</button>
              )}
            </div>
          )}

          {pending && (
            <p className="notice" role="status">
              Device approval is required on this tailnet. Your request was sent to the
              admins; you will be able to connect once it is approved.
            </p>
          )}

          {issued && (
            <div>
              <CodeBlock value={issued.command} label="Connect command" />
              <p className="help-text">
                Run this command on the device you want to connect.{" "}
                {waits && "Then admit the device on Overview: check its name and key fingerprint first. "}
                {issued.reusable ? "The key can be used for several devices" : "The key can only be used once"}{" "}
                and expires in {expiryLabel(issued.expiresInHours)}. You can revoke it under Issued keys on this page.
              </p>
            </div>
          )}

          <button type="submit" className={issued ? "btn-ghost" : undefined} disabled={generating}>
            {generating ? "Generating…" : issued ? "Generate new key" : "Generate auth key"}
          </button>
        </form>
      </Card>
  );
}
