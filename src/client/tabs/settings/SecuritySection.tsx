import { useEffect, useState } from "react";
import { securityService } from "../../services/security";
import { boardsService } from "../../services/boards";
import { useTenantMutation } from "../../hooks/useMutation";
import { useTenantData } from "../../hooks/useTenantData";
import { useSession } from "../../hooks/session";
import { SettingsCards, TOGGLE_SETTINGS, type BoolSettingKey } from "../security/SettingsCard";
import { HibernationCard } from "../security/LimitsCards";
import { DeviceAccessCard } from "../boards/DeviceAccessCard";

export function SecuritySection() {
  const { settings, reloadSettings, currentTenant } = useSession();
  const { mutate, busy } = useTenantMutation({ reload: reloadSettings });
  const [hibernateDays, setHibernateDays] = useState(settings?.hibernateAfterDays ?? 0);
  useEffect(() => {
    if (settings) setHibernateDays(settings.hibernateAfterDays);
  }, [settings?.hibernateAfterDays]);

  const handleToggle = async (key: BoolSettingKey, value: boolean) => {
    await mutate((tid) => securityService.updateSetting(tid, key, value), {
      successMsg: `${TOGGLE_SETTINGS.find((t) => t.key === key)?.label ?? key} ${value ? "turned on" : "turned off"}`,
    });
  };

  const handleSaveHibernation = async (e: React.FormEvent) => {
    e.preventDefault();
    await mutate((tid) => securityService.updateSetting(tid, "hibernateAfterDays", hibernateDays), {
      successMsg: "Hibernation setting saved",
    });
  };

  return (
    <div className="tab-content">
      <SettingsCards settings={settings} busy={busy} onToggle={handleToggle} />
      <AccessModeSection />
      {/* Hibernation stops an idle Headscale container; the coordinator has none */}
      {!currentTenant?.coordinatorMode && (
        <HibernationCard days={hibernateDays} onChange={setHibernateDays} busy={busy} onSave={handleSaveHibernation} />
      )}
    </div>
  );
}

/** The tailnet's device access mode. Legacy mode has none, so a failed load shows nothing. */
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
