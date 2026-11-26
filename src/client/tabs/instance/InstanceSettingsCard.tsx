import { Card } from "../../components/Card";
import { Toggle } from "../../components/Toggle";
import type { InstanceInfo, OperatorOverview } from "../../lib/types";

export function InstanceSettingsCard({
  overview,
  instance,
  busy,
  conflict,
  onSingleTailnet,
  onDefault,
}: {
  overview: OperatorOverview;
  instance: InstanceInfo | null;
  busy: boolean;
  conflict: string[] | null;
  onSingleTailnet: (value: boolean) => void;
  onDefault: (tenantId: string) => void;
}) {
  const settings = overview.settings;
  const topLevel = overview.tenants.filter((t) => !t.parentId && t.status !== "deleted");
  return (
    <Card title="Instance settings">
      <div className="toggle-group">
        <Toggle
          label="Single-tailnet mode"
          description="The instance holds at most one top-level tailnet. Nobody, including tailnet creators, can create another tailnet or a sub-collective while this is on."
          checked={settings.singleTailnet}
          disabled={busy}
          onChange={onSingleTailnet}
        />
      </div>
      {conflict && (
        <div className="inline-alert" role="alert">
          <p>
            Single-tailnet mode can&apos;t be turned on while this instance has more than one top-level
            tailnet. Delete all but one of these first:
          </p>
          <ul>
            {conflict.map((n) => <li key={n}>{n}</li>)}
          </ul>
        </div>
      )}
      <div className="form-section">
        <h4><label htmlFor="default-tailnet">Default tailnet</label></h4>
        <p className="help-text" id="default-tailnet-help">
          Signed-in people without a tailnet are offered a &ldquo;Request to join&rdquo; button for the
          default tailnet. Join requests are enabled on it; its admins approve them on Overview.
        </p>
        <select
          id="default-tailnet"
          aria-describedby="default-tailnet-help"
          value={settings.defaultTailnetId ?? ""}
          disabled={busy}
          onChange={(e) => onDefault(e.target.value)}
        >
          <option value="">None (invite-only)</option>
          {topLevel.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
        {instance?.defaultTailnet && !instance.defaultTailnet.acceptsJoinRequests && (
          <p className="help-text mt-8" role="status">
            {instance.defaultTailnet.name} currently isn&apos;t accepting join requests (it may be in
            lockdown or have join requests turned off), so visitors will see the invite-only message.
          </p>
        )}
      </div>
    </Card>
  );
}
