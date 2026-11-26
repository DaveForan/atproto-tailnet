import { securityService } from "../../services/security";
import { boardsService } from "../../services/boards";
import { useTenantMutation } from "../../hooks/useMutation";
import { useTenantData } from "../../hooks/useTenantData";
import { useSession } from "../../hooks/session";
import { SettingsCards, TOGGLE_SETTINGS, type BoolSettingKey } from "../security/SettingsCard";
import { DeviceAccessCard } from "../boards/DeviceAccessCard";

export function SecuritySection() {
  const { settings, reloadSettings } = useSession();
  const { mutate, busy } = useTenantMutation({ reload: reloadSettings });

  const handleToggle = async (key: BoolSettingKey, value: boolean) => {
    await mutate((tid) => securityService.updateSetting(tid, key, value), {
      successMsg: `${TOGGLE_SETTINGS.find((t) => t.key === key)?.label ?? key} ${value ? "turned on" : "turned off"}`,
    });
  };

  return (
    <div className="tab-content">
      <SettingsCards settings={settings} busy={busy} onToggle={handleToggle} />
      <AccessModeSection />
    </div>
  );
}

/** The tailnet's device access mode, for those who may change it. */
function AccessModeSection() {
  const { data, error, reload } = useTenantData<{ mode: "open" | "member"; canEdit: boolean } | null>(
    (tid) => boardsService.accessMode(tid),
    null,
  );
  const { mutate, busy } = useTenantMutation({ onError: "Could not change the access mode", reload });
  if (!data || error || !data.canEdit) return null;
  return (
    <DeviceAccessCard
      mode={data.mode}
      busy={busy}
      onChange={(next) => { void mutate((tid) => boardsService.setAccessMode(tid, next), { successMsg: "Access mode changed" }); }}
    />
  );
}
