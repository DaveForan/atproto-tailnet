import { useState } from "react";
import { useApp } from "../hooks/useAppState";
import { useToast } from "../components/Toast";
import { Card } from "../components/Card";
import { copyToClipboard } from "../lib/utils";
import { deviceService } from "../services/devices";
import type { AuthKeyResponse } from "../lib/types";

export function ConnectTab() {
  const { currentTenant } = useApp();
  const { toast, toastError } = useToast();
  const [authKey, setAuthKey] = useState<AuthKeyResponse | null>(null);
  const [generating, setGenerating] = useState(false);

  const handleGenerate = async () => {
    if (!currentTenant) return;
    setGenerating(true);
    try {
      const result = await deviceService.generateAuthKey(currentTenant.id);
      if (result) {
        setAuthKey(result);
        toast("Auth key generated");
      }
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Failed to generate auth key");
    } finally {
      setGenerating(false);
    }
  };

  const fullCommand = authKey
    ? `tailscale up --login-server ${authKey.loginServer} --authkey ${authKey.authKey}`
    : "";

  const handleCopy = () => {
    copyToClipboard(fullCommand);
    toast("Copied to clipboard");
  };

  return (
    <div className="tab-content">
      <Card title="Add a Device">
        <p className="card-description">
          Generate an auth key to connect a new device to this tailnet. Run the
          command on the device you want to add.
        </p>

        {!authKey ? (
          <button
            className="btn btn-primary"
            onClick={handleGenerate}
            disabled={generating}
          >
            {generating ? "Generating..." : "Generate Auth Key"}
          </button>
        ) : (
          <div className="auth-key-result">
            <div className="code-block-wrapper">
              <pre className="code-block">{fullCommand}</pre>
              <button className="btn-sm btn-ghost copy-btn" onClick={handleCopy}>
                Copy
              </button>
            </div>
            <p className="help-text">
              Run this command on the device you want to connect. The auth key
              can only be used once.
            </p>
            <button
              className="btn btn-ghost"
              onClick={handleGenerate}
              disabled={generating}
            >
              Generate New Key
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}
