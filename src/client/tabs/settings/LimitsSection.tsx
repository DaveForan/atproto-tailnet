import { useEffect, useState } from "react";
import { useTenantData } from "../../hooks/useTenantData";
import { useTenantMutation } from "../../hooks/useMutation";
import { useTenant } from "../../hooks/session";
import { usageService } from "../../services/usage";
import { Card } from "../../components/Card";
import { Loading } from "../../components/Loading";
import type { UsageData } from "../../lib/types";
import { LoadError } from "../../components/LoadError";

const USAGE_FALLBACK: UsageData = {
  current: { devices: 0, onlineDevices: 0, members: 0 },
  limits: { maxDevices: 0, maxMembers: 0, waitingDeviceHours: 168 },
  overLimit: { devices: false, members: false },
  history: [],
};

const MAX_CAP = 10000;
const MAX_WAITING_HOURS = 8760;
type WaitUnit = "hours" | "days";
const unitHours = (u: WaitUnit) => (u === "days" ? 24 : 1);

function clampWait(v: string, unit: WaitUnit): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return unitHours(unit);
  return Math.min(n * unitHours(unit), MAX_WAITING_HOURS);
}
const fmtLimit = (n: number) => (n > 0 ? String(n) : "∞");

function clampCap(v: string): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, MAX_CAP);
}

export function LimitsSection() {
  const { currentTenant } = useTenant();
  const { data: usage, loading, error, reload } = useTenantData<UsageData>(
    (tid) => usageService.getUsage(tid),
    USAGE_FALLBACK,
  );
  const { mutate, busy } = useTenantMutation({
    onSuccess: "Limits updated",
    onError: "Failed to update limits",
    reload,
  });
  const [maxDevices, setMaxDevices] = useState(0);
  const [maxMembers, setMaxMembers] = useState(0);
  const [waitHours, setWaitHours] = useState(168);
  const [waitUnit, setWaitUnit] = useState<WaitUnit>("days");

  useEffect(() => {
    setMaxDevices(usage.limits.maxDevices);
    setMaxMembers(usage.limits.maxMembers);
    setWaitHours(usage.limits.waitingDeviceHours);
    setWaitUnit(usage.limits.waitingDeviceHours % 24 === 0 ? "days" : "hours");
  }, [usage.limits.maxDevices, usage.limits.maxMembers, usage.limits.waitingDeviceHours]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    await mutate((tid) => usageService.setLimits(tid, { maxDevices, maxMembers, waitingDeviceHours: waitHours }));
  };

  if (loading) return <Loading />;

  const { current, limits } = usage;
  const dirty =
    maxDevices !== limits.maxDevices || maxMembers !== limits.maxMembers || waitHours !== limits.waitingDeviceHours;
  const belowCurrent =
    (maxDevices > 0 && maxDevices < current.devices) ||
    (maxMembers > 0 && maxMembers < current.members);

  return (
    <div className="tab-content">
      <LoadError error={error} onRetry={reload} />
      <Card title="Limits">
        {currentTenant?.isOriginator ? (
          <form className="form-stack" onSubmit={handleSave}>
            <p className="card-description">
              This tailnet has {current.devices} devices and {current.members} members. Caps are enforced when issuing auth keys, approving devices, accepting invitations,
              and approving join requests. 0 means unlimited. A sub-collective&apos;s caps cannot exceed
              its parent&apos;s.
            </p>
            <div className="field-row">
              <div className="field">
                <label htmlFor="limit-devices">Max devices</label>
                <input
                  id="limit-devices"
                  type="number"
                  min={0}
                  max={MAX_CAP}
                  value={maxDevices}
                  onChange={(e) => setMaxDevices(clampCap(e.target.value))}
                />
              </div>
              <div className="field">
                <label htmlFor="limit-members">Max members</label>
                <input
                  id="limit-members"
                  type="number"
                  min={0}
                  max={MAX_CAP}
                  value={maxMembers}
                  onChange={(e) => setMaxMembers(clampCap(e.target.value))}
                />
              </div>
            </div>
            {currentTenant.coordinatorMode && (
              <div className="field">
                <label htmlFor="limit-wait">Remove a waiting device after</label>
                <div className="field-row">
                  <input
                    id="limit-wait"
                    type="number"
                    min={1}
                    max={MAX_WAITING_HOURS / unitHours(waitUnit)}
                    value={Math.max(1, Math.round(waitHours / unitHours(waitUnit)))}
                    onChange={(e) => setWaitHours(clampWait(e.target.value, waitUnit))}
                  />
                  <select
                    aria-label="Unit of the waiting time"
                    value={waitUnit}
                    onChange={(e) => {
                      const unit = e.target.value as WaitUnit;
                      setWaitUnit(unit);
                      // The time stays the same; days cannot show a part of a day
                      if (unit === "days") setWaitHours(Math.max(24, Math.round(waitHours / 24) * 24));
                    }}
                  >
                    <option value="hours">hours</option>
                    <option value="days">days</option>
                  </select>
                </div>
                <p className="help-text">
                  A new device that nobody admits in this time is removed. The device can be added again. The longest
                  time is one year.
                </p>
              </div>
            )}
            {belowCurrent && (
              <p className="notice" role="status">
                A cap below current usage blocks new additions but does not remove existing devices or members.
              </p>
            )}
            <button type="submit" disabled={busy || !dirty}>
              {busy ? "Saving…" : "Save limits"}
            </button>
          </form>
        ) : (
          <p className="card-description">
            Max devices: {fmtLimit(limits.maxDevices)} · Max members: {fmtLimit(limits.maxMembers)}. A device that
            waits for admission is removed after {limits.waitingDeviceHours} hours.
            Only the originator can change these limits.
          </p>
        )}
      </Card>

    </div>
  );
}
