import { useCallback, useEffect, useState } from "react";
import { securityService } from "../services/security";
import { useTenantMutation } from "../hooks/useMutation";
import { useApp } from "../hooks/useAppState";
import { useToast } from "../components/Toast";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { Toggle } from "../components/Toggle";
import { errorMessage, relativeTime } from "../lib/utils";
import { notificationService } from "../services/notifications";
import type {
  WebhookTestResult,
  Settings,
  DeviceApproval,
  JoinRequest,
} from "../lib/types";

type BoolSettingKey = {
  [K in keyof Settings]-?: Settings[K] extends boolean ? K : never;
}[keyof Settings];

const TOGGLE_SETTINGS: Array<{ key: BoolSettingKey; label: string; description: string }> = [
  { key: "lockdownMode", label: "Lockdown Mode", description: "Block invitations, joins, and device registrations" },
  { key: "requireDeviceApproval", label: "Require Device Approval", description: "New devices wait for admin approval before they can join. Admins get a dashboard notification (and a webhook call, if configured below) for each request." },
  { key: "requireServiceDeviceApproval", label: "Require Service Device Approval", description: "Service devices need admin approval" },
  { key: "requireServiceApproval", label: "Require Service Approval", description: "Services need admin approval before activation" },
  { key: "allowJoinRequests", label: "Allow Join Requests", description: "Allow non-members to request to join" },
  { key: "boardEnabled", label: "Board Enabled", description: "Enable the public message board" },
  { key: "allowAgentTokens", label: "Allow Agent Tokens", description: "Enable AI agent token creation" },
  { key: "allowMemberAgentTokens", label: "Allow Member Agent Tokens", description: "Allow non-originator members to create agent tokens" },
];

export function SecurityTab() {
  const { currentTenant, settings, reloadSettings, hasPerm } = useApp();
  const { toast, toastError } = useToast();
  const { mutate, busy: mutBusy } = useTenantMutation();
  const [deviceApprovals, setDeviceApprovals] = useState<DeviceApproval[]>([]);
  const [joinRequests, setJoinRequests] = useState<JoinRequest[]>([]);
  const [loading, setLoading] = useState(true);

  const [hibernateDays, setHibernateDays] = useState(
    settings?.hibernateAfterDays ?? 0,
  );
  const [maxPosts, setMaxPosts] = useState(settings?.maxBoardPosts ?? 100);
  const [maxPostsDisplayed, setMaxPostsDisplayed] = useState(
    settings?.maxBoardPostsDisplayed ?? 50,
  );
  const [boardLimitsBusy, setBoardLimitsBusy] = useState(false);

  const loadSecurity = useCallback(async () => {
    if (!currentTenant) return;
    try {
      const { settings: s, approvals: da, joinRequests: jr } =
        await securityService.getAll(currentTenant.id);
      if (s) {
        setHibernateDays(s.hibernateAfterDays);
        setMaxPosts(s.maxBoardPosts);
        setMaxPostsDisplayed(s.maxBoardPostsDisplayed);
      }
      setDeviceApprovals(da);
      setJoinRequests(jr);
    } catch (e) {
      toastError(
        e instanceof Error ? e.message : "Failed to load security data",
      );
    } finally {
      setLoading(false);
    }
  }, [currentTenant?.id]);

  useEffect(() => { loadSecurity(); }, [loadSecurity]);

  const handleToggle = async (key: BoolSettingKey, value: boolean) => {
    await mutate(
      "/settings",
      { method: "PATCH", body: JSON.stringify({ [key]: value }) },
      { successMsg: `${key} ${value ? "enabled" : "disabled"}`, reload: reloadSettings },
    );
  };

  const handleSaveHibernation = async () => {
    await mutate(
      "/settings",
      { method: "PATCH", body: JSON.stringify({ hibernateAfterDays: hibernateDays }) },
      { successMsg: "Hibernation setting saved", reload: reloadSettings },
    );
  };

  const handleSaveBoardLimits = async () => {
    if (!currentTenant) return;
    setBoardLimitsBusy(true);
    const errors: string[] = [];
    try {
      await securityService.updateSetting(
        currentTenant.id,
        "maxBoardPosts",
        maxPosts,
      );
    } catch (e) {
      errors.push(`maxBoardPosts: ${e instanceof Error ? e.message : "update failed"}`);
    }
    try {
      await securityService.updateSetting(
        currentTenant.id,
        "maxBoardPostsDisplayed",
        maxPostsDisplayed,
      );
    } catch (e) {
      errors.push(`maxBoardPostsDisplayed: ${e instanceof Error ? e.message : "update failed"}`);
    }
    setBoardLimitsBusy(false);
    if (errors.length > 0) {
      toastError(`Failed to save board limits: ${errors.join("; ")}`);
      if (errors.length < 2) {
        // Partial success -- reload to reflect the setting that was saved
        await reloadSettings();
      }
    } else {
      toast("Board limits saved");
      await reloadSettings();
    }
  };

  const handleDeviceApproval = async (id: string, action: "approve" | "reject") => {
    const ok = await mutate(
      `/device-approvals/${id}/${action}`,
      { method: "POST" },
      { successMsg: `Device ${action}d` },
    );
    if (ok) {
      setDeviceApprovals((prev) => prev.filter((da) => da.id !== id));
    }
  };

  const handleJoinRequest = async (id: string, action: "approve" | "reject") => {
    const ok = await mutate(
      `/join-requests/${id}/${action}`,
      { method: "POST" },
      { successMsg: `Join request ${action}d` },
    );
    if (ok) {
      setJoinRequests((prev) => prev.filter((jr) => jr.id !== id));
    }
  };

  if (loading) return <div className="loading">Loading...</div>;

  const pendingApprovals = deviceApprovals.filter(
    (da) => da.status === "pending",
  );
  const pendingJoins = joinRequests.filter((jr) => jr.status === "pending");

  return (
    <div className="tab-content">
      <Card title="Security Settings">
        {TOGGLE_SETTINGS.map((toggle) => (
          <Toggle
            key={toggle.key}
            label={toggle.label}
            description={toggle.description}
            checked={settings?.[toggle.key] ?? false}
            onChange={(v) => handleToggle(toggle.key, v)}
            disabled={mutBusy}
          />
        ))}
      </Card>

      <NotificationsCard canEdit={hasPerm("manage_settings")} />

      <Card title="Hibernation">
        <div className="form-row">
          <label>Hibernate after (days, 0 = disabled):</label>
          <input
            type="number"
            min={0}
            value={hibernateDays}
            onChange={(e) => setHibernateDays(Number(e.target.value))}
          />
          <button
            className="btn-primary"
            onClick={handleSaveHibernation}
            disabled={mutBusy}
          >
            {mutBusy ? "Saving..." : "Save"}
          </button>
        </div>
      </Card>

      <Card title="Board Limits">
        <div className="form-stack">
          <div className="form-row">
            <label>Max posts:</label>
            <input
              type="number"
              min={0}
              value={maxPosts}
              onChange={(e) => setMaxPosts(Number(e.target.value))}
            />
          </div>
          <div className="form-row">
            <label>Max posts displayed:</label>
            <input
              type="number"
              min={0}
              value={maxPostsDisplayed}
              onChange={(e) => setMaxPostsDisplayed(Number(e.target.value))}
            />
          </div>
          <button
            className="btn-primary"
            onClick={handleSaveBoardLimits}
            disabled={boardLimitsBusy}
          >
            {boardLimitsBusy ? "Saving..." : "Save"}
          </button>
        </div>
      </Card>

      <Card title="Pending Device Approvals">
        {pendingApprovals.length === 0 ? (
          <EmptyState>No pending device approvals.</EmptyState>
        ) : (
          <ul className="item-list">
            {pendingApprovals.map((da) => (
              <li key={da.id} className="item-row">
                <div className="item-info">
                  <span className="item-name">
                    {da.displayName || da.handle}
                  </span>
                  <span className="item-meta">
                    Key: {da.machineKey.slice(0, 16)}... |{" "}
                    {relativeTime(da.createdAt)}
                  </span>
                </div>
                <div className="btn-group">
                  <button
                    className="btn-sm btn-primary"
                    onClick={() => handleDeviceApproval(da.id, "approve")}
                    disabled={mutBusy}
                  >
                    Approve
                  </button>
                  <button
                    className="btn-sm btn-danger"
                    onClick={() => handleDeviceApproval(da.id, "reject")}
                    disabled={mutBusy}
                  >
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Pending Join Requests">
        {pendingJoins.length === 0 ? (
          <EmptyState>No pending join requests.</EmptyState>
        ) : (
          <ul className="item-list">
            {pendingJoins.map((jr) => (
              <li key={jr.id} className="item-row">
                <div className="item-info">
                  <span className="item-name">
                    {jr.userDisplayName || jr.userHandle}
                  </span>
                  {jr.message && (
                    <span className="item-meta">{jr.message}</span>
                  )}
                  <span className="item-meta">
                    {relativeTime(jr.requestedAt)}
                  </span>
                </div>
                <div className="btn-group">
                  <button
                    className="btn-sm btn-primary"
                    onClick={() => handleJoinRequest(jr.id, "approve")}
                    disabled={mutBusy}
                  >
                    Approve
                  </button>
                  <button
                    className="btn-sm btn-danger"
                    onClick={() => handleJoinRequest(jr.id, "reject")}
                    disabled={mutBusy}
                  >
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

type SecretMode = "keep" | "replace" | "clear";

function NotificationsCard({ canEdit }: { canEdit: boolean }) {
  const { currentTenant, settings, reloadSettings } = useApp();
  const { toast, toastError } = useToast();
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

  const handleSave = async () => {
    if (!currentTenant) return;
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
      toastError(errorMessage(e, "Failed to save notification settings"));
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
      <div className="form-stack">
        <div className="form-field">
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
        <div className="form-field">
          <label htmlFor="webhook-secret">Signing secret</label>
          {secretMode === "replace" ? (
            <div className="form-row">
              <input
                id="webhook-secret"
                type="password"
                autoComplete="new-password"
                placeholder="New secret"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
              <button className="btn-sm btn-ghost" onClick={() => { setSecretMode("keep"); setSecret(""); }}>
                Cancel
              </button>
            </div>
          ) : (
            <div className="form-row" id="webhook-secret">
              <span className="text-dim text-sm">
                {secretMode === "clear"
                  ? "Secret will be removed on save"
                  : hasSecret ? "Secret set" : "No secret set"}
              </span>
              <button className="btn-sm btn-ghost" onClick={() => setSecretMode("replace")}>
                {hasSecret ? "Replace" : "Set secret"}
              </button>
              {hasSecret && secretMode !== "clear" && (
                <button className="btn-sm btn-danger" onClick={() => setSecretMode("clear")}>
                  Clear
                </button>
              )}
              {secretMode === "clear" && (
                <button className="btn-sm btn-ghost" onClick={() => setSecretMode("keep")}>
                  Undo
                </button>
              )}
            </div>
          )}
        </div>
        <div className="btn-group">
          <button className="btn-primary" onClick={handleSave} disabled={saving || !dirty}>
            {saving ? "Saving..." : "Save"}
          </button>
          <button
            className="btn-ghost"
            onClick={handleTest}
            disabled={testing || !savedUrl || dirty}
            title={dirty ? "Save changes before testing" : undefined}
          >
            {testing ? "Sending..." : "Send test"}
          </button>
        </div>
        {testResult && (
          <p className="help-text" role="status">
            {testResult.ok
              ? `Test delivered${testResult.status ? ` (HTTP ${testResult.status})` : ""}.`
              : `Test failed${testResult.status ? ` (HTTP ${testResult.status})` : ""}${testResult.error ? `: ${testResult.error}` : ""}.`}
          </p>
        )}
      </div>
    </Card>
  );
}
