import { useEffect, useState } from "react";
import { useTenantData } from "../hooks/useTenantData";
import { useTenantMutation } from "../hooks/useMutation";
import { useApp } from "../hooks/useAppState";
import { Card } from "../components/Card";
import { Loading } from "../components/Loading";
import { relativeTime } from "../lib/utils";
import type { UsageData } from "../lib/types";
import { LoadError } from "../components/LoadError";

const USAGE_FALLBACK: UsageData = {
  current: { devices: 0, onlineDevices: 0, members: 0 },
  limits: { maxDevices: 0, maxMembers: 0 },
  overLimit: { devices: false, members: false },
  history: [],
};

const MAX_CAP = 10000;
const fmtLimit = (n: number) => (n > 0 ? String(n) : "∞");

function clampCap(v: string): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, MAX_CAP);
}

export function UsageTab() {
  const { isOriginator } = useApp();
  const { data: usage, loading, error, reload } = useTenantData<UsageData>(
    "/usage",
    USAGE_FALLBACK,
  );
  const { mutate, busy } = useTenantMutation({
    onSuccess: "Limits updated",
    onError: "Failed to update limits",
    reload,
  });
  const [maxDevices, setMaxDevices] = useState(0);
  const [maxMembers, setMaxMembers] = useState(0);

  useEffect(() => {
    setMaxDevices(usage.limits.maxDevices);
    setMaxMembers(usage.limits.maxMembers);
  }, [usage.limits.maxDevices, usage.limits.maxMembers]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    await mutate("/limits", {
      method: "PUT",
      body: JSON.stringify({ maxDevices, maxMembers }),
    });
  };

  if (loading) return <Loading />;

  const { current, limits, overLimit } = usage;
  const dirty = maxDevices !== limits.maxDevices || maxMembers !== limits.maxMembers;
  const belowCurrent =
    (maxDevices > 0 && maxDevices < current.devices) ||
    (maxMembers > 0 && maxMembers < current.members);

  return (
    <div className="tab-content">
      <LoadError error={error} onRetry={reload} />
      {(overLimit.devices || overLimit.members) && (
        <div className="lockdown-banner" role="alert">
          <span>
            Over limit:{" "}
            {[
              overLimit.devices && `${current.devices} devices (cap ${limits.maxDevices})`,
              overLimit.members && `${current.members} members (cap ${limits.maxMembers})`,
            ].filter(Boolean).join(", ")}
            . New {overLimit.devices && overLimit.members ? "devices and members" : overLimit.devices ? "devices" : "members"} are
            blocked until usage drops below the cap or the cap is raised.
          </span>
        </div>
      )}

      <Card title="Current usage">
        <div className="stats-row">
          <div className="stat-card">
            <div className="stat-value">
              {current.devices} / {fmtLimit(limits.maxDevices)}
            </div>
            <div className="stat-label">
              Devices ({current.onlineDevices} online)
              {overLimit.devices && " · over limit"}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-value">
              {current.members} / {fmtLimit(limits.maxMembers)}
            </div>
            <div className="stat-label">
              Members{overLimit.members && " · over limit"}
            </div>
          </div>
          {current.routes !== undefined && (
            <div className="stat-card">
              <div className="stat-value">{current.routes}</div>
              <div className="stat-label">Routes</div>
            </div>
          )}
        </div>
      </Card>

      <Card title="Limits">
        {isOriginator() ? (
          <form className="form-stack" onSubmit={handleSave}>
            <p className="card-description">
              Caps are enforced when issuing auth keys, approving devices, accepting invitations,
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
            Max devices: {fmtLimit(limits.maxDevices)} · Max members: {fmtLimit(limits.maxMembers)}.
            Only the primary admin can change these limits.
          </p>
        )}
      </Card>

      {usage.history.length > 0 && (
        <Card title="Snapshot history">
          <div className="table-wrap">
          <table className="data-table">
            <caption className="sr-only">Usage snapshots, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Devices</th>
                <th scope="col">Members</th>
                <th scope="col">Routes</th>
              </tr>
            </thead>
            <tbody>
              {[...usage.history].reverse().map((snap) => (
                <tr key={snap.id}>
                  <td>{relativeTime(snap.recordedAt)}</td>
                  <td>{snap.deviceCount} ({snap.onlineDevices} online)</td>
                  <td>{snap.memberCount}</td>
                  <td>{snap.routeCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </Card>
      )}
    </div>
  );
}
