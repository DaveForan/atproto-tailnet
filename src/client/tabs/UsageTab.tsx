import { useEffect, useState } from "react";
import { useTenantData } from "../hooks/useTenantData";
import { useTenantMutation } from "../hooks/useMutation";
import { useApp } from "../hooks/useAppState";
import { Card } from "../components/Card";
import { relativeTime } from "../lib/utils";
import { PLANS } from "../lib/constants";
import type { UsageData } from "../lib/types";

const USAGE_FALLBACK: UsageData = {
  currentDevices: 0,
  currentMembers: 0,
  maxDevices: 0,
  maxMembers: 0,
  planName: "",
  snapshots: [],
};

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
    if (usage.planName) setSelectedPlan(usage.planName);
  }, [usage.planName]);

  const handleSavePlan = async () => {
    if (!usage.planName || !selectedPlan) return;
    await mutate("/plan", {
      method: "PUT",
      body: JSON.stringify({
        planName: selectedPlan,
        maxDevices: usage.maxDevices,
        maxMembers: usage.maxMembers,
      }),
    });
  };

  if (loading) return <div className="loading">Loading...</div>;
  if (!usage.planName)
    return <div className="loading">No usage data available.</div>;

  const canManage = hasPerm("manage_settings");

  return (
    <div className="tab-content">
      <Card title="Current Usage">
        <div className="stats-row">
          <div className="stat-card">
            <div className="stat-value">
              {usage.currentDevices} / {usage.maxDevices}
            </div>
            <div className="stat-label">Devices</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">
              {usage.currentMembers} / {usage.maxMembers}
            </div>
            <div className="stat-label">Members</div>
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

      {usage.snapshots && usage.snapshots.length > 0 && (
        <Card title="Snapshot History">
          <table className="data-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Devices</th>
                <th>Members</th>
              </tr>
            </thead>
            <tbody>
              {usage.snapshots.map((snap, i) => (
                <tr key={i}>
                  <td>{relativeTime(snap.timestamp)}</td>
                  <td>{snap.devices}</td>
                  <td>{snap.members}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
