import { useApp } from "../hooks/useAppState";
import { useTenantData } from "../hooks/useTenantData";
import { useTenantMutation } from "../hooks/useMutation";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import type { DevicesData } from "../lib/types";

export function DevicesTab() {
  const { hasPerm, reload } = useApp();
  const { data: devices, loading, reload: reloadDevices } = useTenantData<DevicesData | null>("/devices", null);
  const { mutate, busy } = useTenantMutation({ onError: "Failed to remove device" });

  const handleRemove = async (deviceId: string, deviceName: string) => {
    if (!confirm(`Remove device "${deviceName}"? This cannot be undone.`)) return;
    await mutate(
      `/devices/${deviceId}`,
      { method: "DELETE" },
      { successMsg: "Device removed", reload: async () => { await reloadDevices(); reload(); } },
    );
  };

  if (loading) return <div className="loading">Loading...</div>;

  if (!devices || devices.byUser.length === 0) {
    return (
      <div className="tab-content">
        <Card title="Devices">
          <EmptyState>
            No devices connected. Use the Add Device tab to connect your first device.
          </EmptyState>
        </Card>
      </div>
    );
  }

  return (
    <div className="tab-content">
      <Card title="Devices">
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
                    <div className="device-info">
                      <span className="device-name">
                        {device.givenName || device.name}
                      </span>
                      <span className="device-ips">
                        {device.ipAddresses.join(", ")}
                      </span>
                    </div>
                    {hasPerm("manage_devices") && (
                      <button
                        className="btn-sm btn-danger"
                        disabled={busy}
                        onClick={() =>
                          handleRemove(device.id, device.givenName || device.name)
                        }
                      >
                        {busy ? "Removing..." : "Remove"}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
