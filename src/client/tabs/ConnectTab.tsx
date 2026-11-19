import { useState } from "react";
import { useApp } from "../hooks/useAppState";
import { useToast } from "../components/Toast";
import { Card } from "../components/Card";
import { copyToClipboard, errorCode, errorMessage } from "../lib/utils";
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

  const handleGenerate = async () => {
    if (!currentTenant) return;
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

  const handleCopy = () => {
    if (!issued) return;
    copyToClipboard(issued.command);
    toast("Copied to clipboard");
  };

  return (
    <div className="tab-content">
      <Card title="Add a Device">
        <p className="card-description">
          Generate an auth key to connect a new device to this tailnet. Run the
          command on the device you want to add.
        </p>

        <div className="form-row">
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
          {canManageDevices && (
            <label>
              <input
                type="checkbox"
                checked={reusable}
                onChange={(e) => setReusable(e.target.checked)}
              />{" "}
              Reusable (connect several devices with one key)
            </label>
          )}
        </div>

        {limitError && (
          <div className="lockdown-banner" role="alert">
            <span>{limitError}</span>
            <button className="btn-sm btn-ghost" onClick={() => setTab("usage")}>View limits</button>
          </div>
        )}

        {pending && (
          <p className="help-text" role="status">
            Device approval is required on this tailnet. Your request was sent to the
            admins; you will be able to connect once it is approved.
          </p>
        )}

        {issued && (
          <div className="auth-key-result">
            <div className="code-block-wrapper">
              <pre className="code-block">{issued.command}</pre>
              <button className="btn-sm btn-ghost copy-btn" onClick={handleCopy}>
                Copy
              </button>
            </div>
            <p className="help-text">
              Run this command on the device you want to connect.{" "}
              {issued.reusable ? "The key can be used for several devices" : "The key can only be used once"}{" "}
              and expires in {expiryLabel(issued.expiresInHours)}. You can revoke it from the Devices tab.
            </p>
          </div>
        )}

        <button
          className={issued ? "btn btn-ghost" : "btn btn-primary"}
          onClick={handleGenerate}
          disabled={generating}
        >
          {generating ? "Generating..." : issued ? "Generate New Key" : "Generate Auth Key"}
        </button>
      </Card>
    </div>
  );
}
