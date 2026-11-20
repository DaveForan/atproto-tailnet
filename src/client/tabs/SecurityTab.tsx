import { useCallback, useEffect, useState } from "react";
import { securityService } from "../services/security";
import { useTenantMutation } from "../hooks/useMutation";
import { useSession } from "../hooks/session";
import { Loading } from "../components/Loading";
import { errorMessage } from "../lib/utils";
import type { DeviceApproval, JoinRequest } from "../lib/types";
import { LoadError } from "../components/LoadError";
import { SettingsCard, TOGGLE_SETTINGS, type BoolSettingKey } from "./security/SettingsCard";
import { NotificationsCard } from "./security/NotificationsCard";
import { BoardLimitsCard, HibernationCard } from "./security/LimitsCards";
import { DeviceApprovalsCard, JoinRequestsCard } from "./security/PendingCards";

export function SecurityTab() {
  const { currentTenant, settings, reloadSettings, hasPerm } = useSession();
  const { mutate, busy: mutBusy } = useTenantMutation();
  const [deviceApprovals, setDeviceApprovals] = useState<DeviceApproval[]>([]);
  const [joinRequests, setJoinRequests] = useState<JoinRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [hibernateDays, setHibernateDays] = useState(
    settings?.hibernateAfterDays ?? 0,
  );
  const [maxPosts, setMaxPosts] = useState(settings?.maxBoardPosts ?? 100);
  const [maxPostsDisplayed, setMaxPostsDisplayed] = useState(
    settings?.maxBoardPostsDisplayed ?? 50,
  );

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
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e, "Failed to load security data"));
    } finally {
      setLoading(false);
    }
  }, [currentTenant?.id]);

  useEffect(() => { loadSecurity(); }, [loadSecurity]);

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
    if (ok) {
      setDeviceApprovals((prev) => prev.filter((da) => da.id !== id));
    }
  };

  const handleJoinRequest = async (id: string, action: "approve" | "reject") => {
    const ok = await mutate(
      (tid) => (action === "approve" ? securityService.approveJoin(tid, id) : securityService.rejectJoin(tid, id)),
      { successMsg: `Join request ${action}d` },
    );
    if (ok) {
      setJoinRequests((prev) => prev.filter((jr) => jr.id !== id));
    }
  };

  if (loading) return <Loading />;

  return (
    <div className="tab-content">
      <LoadError error={loadError} onRetry={loadSecurity} />
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
        approvals={deviceApprovals.filter((da) => da.status === "pending")}
        busy={mutBusy}
        onDecide={handleDeviceApproval}
      />
      <JoinRequestsCard
        requests={joinRequests.filter((jr) => jr.status === "pending")}
        busy={mutBusy}
        onDecide={handleJoinRequest}
      />
    </div>
  );
}
