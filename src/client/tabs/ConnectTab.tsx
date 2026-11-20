import { useState } from "react";
import { useApp } from "../hooks/useAppState";
import { useToast } from "../components/Toast";
import { Card } from "../components/Card";
import { CodeBlock } from "../components/CodeBlock";
import { errorCode, errorMessage } from "../lib/utils";
import { deviceService } from "../services/devices";

const EXPIRY_OPTIONS = [1, 24, 24 * 7, 24 * 30];
/** Members without manage_devices get single-use keys of at most 24 hours. */
const MEMBER_EXPIRY_OPTIONS = [1, 24];
const expiryLabel = (h: number) => (h < 24 ? `${h} hour` : h === 24 ? "24 hours" : `${h / 24} days`);

interface IssuedKey {
  command: string;
  reusable: boolean;
  expiresInHours: number;
}

export function ConnectTab() {
  const { currentTenant, setTab, hasPerm } = useApp();
  const canManageDevices = hasPerm("manage_devices");
  const expiryOptions = canManageDevices ? EXPIRY_OPTIONS : MEMBER_EXPIRY_OPTIONS;
  const { toast, toastError } = useToast();
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
    } catch (e) {
      if (errorCode(e) === "device_limit") setLimitError(errorMessage(e, ""));
      else toastError(errorMessage(e, "Failed to generate auth key"));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="tab-content">
      <Card title="Add a device">
        <p className="card-description">
          Generate an auth key to connect a new device to this tailnet. Run the
          command on the device you want to add.
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
              <button type="button" className="btn-sm btn-ghost" onClick={() => setTab("usage")}>View limits</button>
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
                {issued.reusable ? "The key can be used for several devices" : "The key can only be used once"}{" "}
                and expires in {expiryLabel(issued.expiresInHours)}. You can revoke it from the Devices tab.
              </p>
            </div>
          )}

          <button type="submit" className={issued ? "btn-ghost" : undefined} disabled={generating}>
            {generating ? "Generating…" : issued ? "Generate new key" : "Generate auth key"}
          </button>
        </form>
      </Card>
    </div>
  );
}
