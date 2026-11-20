import { useEffect, useState } from "react";
import { Card } from "../../components/Card";
import { useToast } from "../../components/Toast";
import { useSession } from "../../hooks/session";
import { securityService } from "../../services/security";
import { notificationService } from "../../services/notifications";
import { errorMessage } from "../../lib/utils";
import type { WebhookTestResult } from "../../lib/types";

type SecretMode = "keep" | "replace" | "clear";

export function NotificationsCard({ canEdit }: { canEdit: boolean }) {
  const { currentTenant, settings, reloadSettings } = useSession();
  const { toast, toastError, toastFailure } = useToast();
  const [url, setUrl] = useState(settings?.notificationWebhookUrl ?? "");
  const [secretMode, setSecretMode] = useState<SecretMode>("keep");
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<WebhookTestResult | null>(null);

  useEffect(() => {
    setUrl(settings?.notificationWebhookUrl ?? "");
    setSecretMode("keep");
    setSecret("");
  }, [settings?.notificationWebhookUrl, settings?.hasWebhookSecret]);

  const savedUrl = settings?.notificationWebhookUrl ?? "";
  const hasSecret = !!settings?.hasWebhookSecret;

  if (!canEdit) {
    return (
      <Card title="Notifications">
        <p className="card-description">
          Admins are notified in the dashboard about pending approvals.
          {savedUrl ? " A webhook is also configured." : ""}
        </p>
      </Card>
    );
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentTenant || saving) return;
    const body: { notificationWebhookUrl: string | null; notificationWebhookSecret?: string | null } = {
      notificationWebhookUrl: url.trim() || null,
    };
    if (secretMode === "replace") {
      if (!secret) {
        toastError("Enter a secret or cancel replacing it");
        return;
      }
      body.notificationWebhookSecret = secret;
    } else if (secretMode === "clear") {
      body.notificationWebhookSecret = null;
    }
    setSaving(true);
    try {
      await securityService.updateWebhook(currentTenant.id, body);
      toast("Notification settings saved");
      setTestResult(null);
      await reloadSettings();
    } catch (e) {
      toastFailure(e, "Failed to save notification settings");
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!currentTenant) return;
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await notificationService.testWebhook(currentTenant.id));
    } catch (e) {
      setTestResult({ ok: false, error: errorMessage(e, "Test failed") });
    } finally {
      setTesting(false);
    }
  };

  const dirty = url.trim() !== savedUrl || secretMode !== "keep";

  return (
    <Card title="Notifications">
      <p className="card-description">
        Admins with the matching approval permission are notified in the dashboard when devices,
        members, or services need approval. Optionally also POST each notification to a webhook
        (e.g. a self-hosted ntfy, Gotify, or Matrix bridge). Requests are signed with
        an HMAC-SHA256 <code>X-Atproto-Tailnet-Signature</code> header when a secret is set.
      </p>
      <form className="form-stack" onSubmit={handleSave} noValidate>
        <div className="field">
          <label htmlFor="webhook-url">Webhook URL</label>
          <input
            id="webhook-url"
            type="url"
            inputMode="url"
            placeholder="https://ntfy.example.com/tailnet-alerts"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        {secretMode === "replace" ? (
          <div className="field">
            <label htmlFor="webhook-secret">New signing secret</label>
            <div className="inline-form">
              <input
                id="webhook-secret"
                type="password"
                autoComplete="new-password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
              <button type="button" className="btn-sm btn-ghost" onClick={() => { setSecretMode("keep"); setSecret(""); }}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="field" role="group" aria-labelledby="webhook-secret-label">
            <span className="field-label" id="webhook-secret-label">Signing secret</span>
            <div className="btn-group">
              <span className="text-sm" role="status">
                {secretMode === "clear"
                  ? "Secret will be removed on save"
                  : hasSecret ? "Secret set" : "No secret set"}
              </span>
              <button type="button" className="btn-sm btn-ghost" onClick={() => setSecretMode("replace")}>
                {hasSecret ? "Replace" : "Set secret"}
              </button>
              {hasSecret && secretMode !== "clear" && (
                <button type="button" className="btn-sm btn-danger" onClick={() => setSecretMode("clear")}>
                  Clear
                </button>
              )}
              {secretMode === "clear" && (
                <button type="button" className="btn-sm btn-ghost" onClick={() => setSecretMode("keep")}>
                  Undo
                </button>
              )}
            </div>
          </div>
        )}
        <div className="form-footer">
          <button type="submit" disabled={saving || !dirty}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={handleTest}
            disabled={testing || !savedUrl || dirty}
            title={dirty ? "Save changes before testing" : undefined}
          >
            {testing ? "Sending…" : "Send test"}
          </button>
        </div>
        {testResult && (
          <p className={`notice${testResult.ok ? " notice-ok" : ""}`} role="status">
            {testResult.ok
              ? `Test delivered${testResult.status ? ` (HTTP ${testResult.status})` : ""}.`
              : `Test failed${testResult.status ? ` (HTTP ${testResult.status})` : ""}${testResult.error ? `: ${testResult.error}` : ""}.`}
          </p>
        )}
      </form>
    </Card>
  );
}
