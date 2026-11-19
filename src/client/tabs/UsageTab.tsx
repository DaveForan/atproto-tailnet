import { useEffect, useState } from "react";
import { useTenantData } from "../hooks/useTenantData";
import { useTenantMutation } from "../hooks/useMutation";
import { useApp } from "../hooks/useAppState";
import { Card } from "../components/Card";
import { relativeTime } from "../lib/utils";
import { PLANS } from "../lib/constants";
import type { UsageData } from "../lib/types";

const USAGE_FALLBACK: UsageData = {
  current: { deviceCount: 0, onlineDevices: 0, memberCount: 0, routeCount: 0 },
  plan: { name: "", maxDevices: 0, maxMembers: 0 },
  limits: { devicesExceeded: false, membersExceeded: false },
  history: [],
};

const fmtLimit = (n: number) => (n > 0 ? String(n) : "∞");

export function UsageTab() {
  const { hasPerm } = useApp();
  const { data: usage, loading, reload } = useTenantData<UsageData>(
    "/usage",
    USAGE_FALLBACK,
  );
  const { mutate, busy } = useTenantMutation({
    onSuccess: "Plan updated",
    reload,
  });
  const [selectedPlan, setSelectedPlan] = useState("");

  useEffect(() => {
    if (usage.plan.name) setSelectedPlan(usage.plan.name);
  }, [usage.plan.name]);

  const handleSavePlan = async () => {
    if (!usage.plan.name || !selectedPlan) return;
    await mutate("/plan", {
      method: "PUT",
      body: JSON.stringify({ planName: selectedPlan }),
    });
  };

  if (loading) return <div className="loading">Loading...</div>;
  if (!usage.plan.name)
    return <div className="loading">No usage data available.</div>;

  const canManage = hasPerm("manage_settings");

  return (
    <div className="tab-content">
      <Card title="Current Usage">
        <div className="stats-row">
          <div className="stat-card">
            <div className="stat-value">
              {usage.current.deviceCount} / {fmtLimit(usage.plan.maxDevices)}
            </div>
            <div className="stat-label">
              Devices ({usage.current.onlineDevices} online)
              {usage.limits.devicesExceeded && " · over limit"}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-value">
              {usage.current.memberCount} / {fmtLimit(usage.plan.maxMembers)}
            </div>
            <div className="stat-label">
              Members{usage.limits.membersExceeded && " · over limit"}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{usage.current.routeCount}</div>
            <div className="stat-label">Routes</div>
          </div>
        </div>
      </Card>

      <Card title="Plan">
        <div className="form-row">
          <select
            value={selectedPlan}
            onChange={(e) => setSelectedPlan(e.target.value)}
            disabled={!canManage}
          >
            {PLANS.map((plan) => (
              <option key={plan} value={plan}>
                {plan}
              </option>
            ))}
          </select>
          {canManage && (
            <button
              className="btn-primary"
              onClick={handleSavePlan}
              disabled={busy}
            >
              {busy ? "Saving..." : "Save"}
            </button>
          )}
        </div>
      </Card>

      {usage.history.length > 0 && (
        <Card title="Snapshot History">
          <table className="data-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Devices</th>
                <th>Members</th>
                <th>Routes</th>
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
        </Card>
      )}
    </div>
  );
}
