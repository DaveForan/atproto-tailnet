import { Card } from "../components/Card";
import { Badge } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { TailnetAddressCard } from "../components/TailnetAddress";
import { useTenantParallel } from "../hooks/useTenantData";
import type { DevicesData, HealthData } from "../lib/types";

interface StatusData {
  devices: DevicesData | null;
  health: HealthData | null;
}

const STATUS_SPECS = [
  { path: "/devices", key: "devices" },
  { path: "/health", key: "health" },
];
const STATUS_FALLBACK: StatusData = { devices: null, health: null };

export function StatusTab() {
  const { data, loading } = useTenantParallel<StatusData>(
    STATUS_SPECS,
    STATUS_FALLBACK,
  );
  const { devices, health } = data;

  if (loading) return <div className="loading">Loading...</div>;

  let totalDevices = 0;
  let onlineDevices = 0;
  if (devices) {
    for (const group of devices.byUser) {
      for (const d of group.devices) {
        totalDevices++;
        if (d.online) onlineDevices++;
      }
    }
  }

  return (
    <div className="tab-content">
      <Card title="Health">
        <div className="stats-row">
          <div className="stat-card">
            <div className="stat-value">
              <Badge variant={health?.status === "healthy" ? "running" : "stopped"}>
                {health?.status ?? "unknown"}
              </Badge>
            </div>
            <div className="stat-label">Coordinator</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{totalDevices}</div>
            <div className="stat-label">Devices</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{onlineDevices}</div>
            <div className="stat-label">Online</div>
          </div>
        </div>
      </Card>

      <TailnetAddressCard />

      <Card title="Devices by User">
        {devices && devices.byUser.length > 0 ? (
          <div className="device-groups">
            {devices.byUser.map((group) => (
              <div key={group.hsUsername} className="device-group">
                <div className="device-group-header">{group.hsUsername}</div>
                <ul className="device-list">
                  {group.devices.map((device) => (
                    <li key={device.id} className="device-row">
                      <span
                        className={`online-dot ${device.online ? "online" : "offline"}`}
                      />
                      <span className="device-name">
                        {device.givenName || device.name}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState>No devices connected yet.</EmptyState>
        )}
      </Card>
    </div>
  );
}
