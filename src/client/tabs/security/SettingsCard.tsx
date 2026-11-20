import { Card } from "../../components/Card";
import { Toggle } from "../../components/Toggle";
import type { Settings } from "../../lib/types";

export type BoolSettingKey = {
  [K in keyof Settings]-?: Settings[K] extends boolean ? K : never;
}[keyof Settings];

export const TOGGLE_SETTINGS: Array<{ key: BoolSettingKey; label: string; description: string }> = [
  { key: "lockdownMode", label: "Lockdown mode", description: "Block invitations, joins, and device registrations" },
  { key: "requireDeviceApproval", label: "Require device approval", description: "New devices wait for admin approval before they can join. Admins get a dashboard notification (and a webhook call, if configured below) for each request." },
  { key: "requireServiceApproval", label: "Require service approval", description: "Services need admin approval before activation" },
  { key: "allowJoinRequests", label: "Allow join requests", description: "Allow non-members to request to join" },
  { key: "boardEnabled", label: "Board enabled", description: "Enable the public message board" },
  { key: "allowAgentTokens", label: "Allow agent tokens", description: "Enable AI agent token creation" },
  { key: "allowMemberAgentTokens", label: "Allow member agent tokens", description: "Allow non-originator members to create agent tokens" },
];

export function SettingsCard({
  settings,
  busy,
  onToggle,
}: {
  settings: Settings | null;
  busy: boolean;
  onToggle: (key: BoolSettingKey, value: boolean) => void;
}) {
  return (
    <Card title="Security settings">
      <div className="toggle-group">
      {TOGGLE_SETTINGS.map((toggle) => (
        <Toggle
          key={toggle.key}
          label={toggle.label}
          description={toggle.description}
          checked={settings?.[toggle.key] ?? false}
          onChange={(v) => onToggle(toggle.key, v)}
          disabled={busy}
        />
      ))}
      </div>
    </Card>
  );
}
