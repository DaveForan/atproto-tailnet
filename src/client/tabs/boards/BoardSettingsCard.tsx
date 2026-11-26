import { Card } from "../../components/Card";
import { Toggle } from "../../components/Toggle";
import { useSession } from "../../hooks/session";
import { useTenantMutation } from "../../hooks/useMutation";
import { securityService } from "../../services/security";

export function BoardSettingsCard() {
  const { settings, reloadSettings } = useSession();
  const { mutate, busy } = useTenantMutation({ onError: "Could not change the board", reload: reloadSettings });
  const boardOn = settings?.boardEnabled ?? false;
  return (
    <Card title="Board settings">
      <div className="toggle-group">
        <Toggle
          label="Public board"
          description="Members can offer services to this tailnet and connect to the services of others. Private services work without it."
          checked={boardOn}
          disabled={busy}
          onChange={(on) => {
            void mutate((tid) => securityService.updateSetting(tid, "boardEnabled", on), {
              successMsg: on ? "Public board turned on" : "Public board turned off",
            });
          }}
        />
        <Toggle
          label="Approve services before they show"
          description="A new or changed public service waits in the approval queue until the originator or an approver accepts it. When this is off, it shows on the board immediately. Your own services never wait."
          checked={settings?.requireServiceApproval ?? true}
          disabled={busy || !boardOn}
          onChange={(on) => {
            void mutate((tid) => securityService.updateSetting(tid, "requireServiceApproval", on), {
              successMsg: on ? "Services now wait for approval" : "Services now show without approval",
            });
          }}
        />
      </div>
    </Card>
  );
}
