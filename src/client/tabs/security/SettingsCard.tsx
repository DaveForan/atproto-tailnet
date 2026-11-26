import { Card } from "../../components/Card";
import { Toggle } from "../../components/Toggle";
import type { Settings } from "../../lib/types";

export type BoolSettingKey = {
  [K in keyof Settings]-?: Settings[K] extends boolean ? K : never;
}[keyof Settings];

interface ToggleSetting {
  key: BoolSettingKey;
  label: string;
  description: string;
}

/** Security switches, one card for each job. */
export const SETTING_GROUPS: Array<{ title: string; toggles: ToggleSetting[] }> = [
  {
    title: "Joining",
    toggles: [
      { key: "allowJoinRequests", label: "Allow join requests", description: "People who are not members can ask to join. An approver answers each request on Overview." },
      { key: "requireDeviceApproval", label: "Approvers also admit new devices", description: "While this is on, an approver must admit each new device on Overview after its owner did, and no member can turn off the approval of their own devices. The device of an approver needs a different approver, when there is one." },
    ],
  },
  {
    title: "Agent tokens",
    toggles: [
      { key: "allowAgentTokens", label: "Allow agent tokens", description: "Tokens that let an AI agent act in this tailnet with chosen permissions." },
      { key: "allowMemberAgentTokens", label: "Allow member agent tokens", description: "Members other than the originator can also create tokens." },
    ],
  },
  {
    title: "Lockdown",
    toggles: [
      { key: "lockdownMode", label: "Lockdown mode", description: "Stops invitations, joins, new devices and new tokens until you turn it off. Connected devices keep working." },
    ],
  },
];

export const TOGGLE_SETTINGS: ToggleSetting[] = SETTING_GROUPS.flatMap((g) => g.toggles);

export function SettingsCards({
  settings,
  busy,
  onToggle,
}: {
  settings: Settings | null;
  busy: boolean;
  onToggle: (key: BoolSettingKey, value: boolean) => void;
}) {
  return (
    <>
      {SETTING_GROUPS.map((group) => (
        <Card key={group.title} title={group.title}>
          <div className="toggle-group">
            {group.toggles.map((toggle) => (
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
      ))}
    </>
  );
}
