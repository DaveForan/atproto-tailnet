import { useState } from "react";
import { securityService } from "../services/security";
import { useTenantMutation } from "../hooks/useMutation";
import { useTenantParallel, type TenantLoaders } from "../hooks/useTenantData";
import { useSession } from "../hooks/session";
import { Loading } from "../components/Loading";
import type { DeviceApproval, JoinRequest, Settings } from "../lib/types";
import { LoadError } from "../components/LoadError";
import { SettingsCard, TOGGLE_SETTINGS, type BoolSettingKey } from "./security/SettingsCard";
import { NotificationsCard } from "./security/NotificationsCard";
import { BoardLimitsCard, HibernationCard } from "./security/LimitsCards";
import { DeviceApprovalsCard, JoinRequestsCard } from "./security/PendingCards";

interface SecurityData {
  settings: Settings | null;
  approvals: DeviceApproval[];
  joinRequests: JoinRequest[];
}

const LOADERS: TenantLoaders<SecurityData> = {
  settings: (tid) => securityService.getSettings(tid),
  approvals: (tid) => securityService.deviceApprovals(tid),
  joinRequests: (tid) => securityService.joinRequests(tid),
};

export function SecurityTab() {
  const { settings, reloadSettings, hasPerm } = useSession();
  const { mutate, busy: mutBusy } = useTenantMutation();
  const { data, loading, error, reload } = useTenantParallel(
    LOADERS,
    { settings: null, approvals: [], joinRequests: [] },
    { keepPreviousOnReload: true },
  );
  // Requests decided here leave the lists without a reload
  const [decided, setDecided] = useState<ReadonlySet<string>>(new Set());
  const decide = (id: string) => setDecided((prev) => new Set(prev).add(id));

  const [hibernateDays, setHibernateDays] = useState(
    settings?.hibernateAfterDays ?? 0,
  );
  const [maxPosts, setMaxPosts] = useState(settings?.maxBoardPosts ?? 100);
  const [maxPostsDisplayed, setMaxPostsDisplayed] = useState(
    settings?.maxBoardPostsDisplayed ?? 50,
  );

  // Each loaded settings object resets the number fields once
  const [seeded, setSeeded] = useState<Settings | null>(null);
  if (data.settings && data.settings !== seeded) {
    setSeeded(data.settings);
    setHibernateDays(data.settings.hibernateAfterDays);
    setMaxPosts(data.settings.maxBoardPosts);
    setMaxPostsDisplayed(data.settings.maxBoardPostsDisplayed);
  }

  const handleToggle = async (key: BoolSettingKey, value: boolean) => {
    await mutate(
      (tid) => securityService.updateSetting(tid, key, value),
      {
        successMsg: `${TOGGLE_SETTINGS.find((t) => t.key === key)?.label ?? key} ${value ? "turned on" : "turned off"}`,
        reload: reloadSettings,
      },
    );
  };

  const handleSaveHibernation = async (e: React.FormEvent) => {
    e.preventDefault();
    await mutate(
      (tid) => securityService.updateSetting(tid, "hibernateAfterDays", hibernateDays),
      { successMsg: "Hibernation setting saved", reload: reloadSettings },
    );
  };

  const handleDeviceApproval = async (id: string, action: "approve" | "reject") => {
    const ok = await mutate(
      (tid) => (action === "approve" ? securityService.approveDevice(tid, id) : securityService.rejectDevice(tid, id)),
      { successMsg: `Device ${action}d` },
    );
    if (ok) decide(id);
  };

  const handleJoinRequest = async (id: string, action: "approve" | "reject") => {
    const ok = await mutate(
      (tid) => (action === "approve" ? securityService.approveJoin(tid, id) : securityService.rejectJoin(tid, id)),
      { successMsg: `Join request ${action}d` },
    );
    if (ok) decide(id);
  };

  if (loading) return <Loading />;

  return (
    <div className="tab-content">
      <LoadError error={error} onRetry={reload} />
      <SettingsCard settings={settings} busy={mutBusy} onToggle={handleToggle} />
      <NotificationsCard canEdit={hasPerm("manage_settings")} />
      <HibernationCard days={hibernateDays} onChange={setHibernateDays} busy={mutBusy} onSave={handleSaveHibernation} />
      <BoardLimitsCard
        maxPosts={maxPosts}
        setMaxPosts={setMaxPosts}
        maxPostsDisplayed={maxPostsDisplayed}
        setMaxPostsDisplayed={setMaxPostsDisplayed}
      />
      <DeviceApprovalsCard
        approvals={data.approvals.filter((da) => da.status === "pending" && !decided.has(da.id))}
        busy={mutBusy}
        onDecide={handleDeviceApproval}
      />
      <JoinRequestsCard
        requests={data.joinRequests.filter((jr) => jr.status === "pending" && !decided.has(jr.id))}
        busy={mutBusy}
        onDecide={handleJoinRequest}
      />
    </div>
  );
}
