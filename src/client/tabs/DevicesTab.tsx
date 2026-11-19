import { useApp } from "../hooks/useAppState";
import { useTenantData } from "../hooks/useTenantData";
import { useTenantMutation } from "../hooks/useMutation";
import { Card } from "../components/Card";
import { Badge } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { formatExpiry, relativeTime } from "../lib/utils";
import type { AuthKeyInfo, DevicesData } from "../lib/types";

const KEYS_FALLBACK: { keys: AuthKeyInfo[] } = { keys: [] };

export function DevicesTab() {
  const { hasPerm, reload, user } = useApp();
  const { data: devices, loading, reload: reloadDevices } = useTenantData<DevicesData | null>("/devices", null);
  const { mutate, busy } = useTenantMutation({ onError: "Failed to remove device" });
  const canManage = hasPerm("manage_devices");

  const handleRemove = async (deviceId: string, deviceName: string) => {
    if (!confirm(`Remove device "${deviceName}"? This cannot be undone.`)) return;
    await mutate(
      `/devices/${deviceId}`,
      { method: "DELETE" },
      { successMsg: "Device removed", reload: async () => { await reloadDevices(); reload(); } },
    );
  };

  if (loading) return <div className="loading">Loading...</div>;

  return (
    <div className="tab-content">
      <Card title="Devices">
        {!devices || devices.byUser.length === 0 ? (
          <EmptyState>
            No devices connected. Use the Add Device tab to connect your first device.
          </EmptyState>
        ) : (
          <div className="device-groups">
            {devices.byUser.map((group) => (
              <div key={group.hsUsername} className="device-group">
                <div className="device-group-header">{group.hsUsername}</div>
                <ul className="device-list">
                  {group.devices.map((device) => {
                    const name = device.givenName || device.name;
                    const canRemove = canManage || (!!user && device.owner?.userId === user.id);
                    return (
                      <li key={device.id} className="device-row">
                        <span
                          className={`online-dot ${device.online ? "online" : "offline"}`}
                        />
                        <div className="device-info">
                          <span className="device-name">{name}</span>
                          <span className="device-ips">
                            {device.ipAddresses.join(", ")}
                          </span>
                          <span className="text-dim text-sm">
                            Owner: {device.owner ? `@${device.owner.handle}` : "—"}
                          </span>
                        </div>
                        {canRemove && (
                          <button
                            className="btn-sm btn-danger"
                            disabled={busy}
                            onClick={() => handleRemove(device.id, name)}
                          >
                            {busy ? "Removing..." : "Remove"}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Card>
      <AuthKeysCard />
    </div>
  );
}

function keyState(k: AuthKeyInfo): "revoked" | "expired" | "used" | "active" {
  if (k.revoked) return "revoked";
  if (k.expiresAt && new Date(k.expiresAt).getTime() <= Date.now()) return "expired";
  if (k.used && !k.reusable) return "used";
  return "active";
}

function AuthKeysCard() {
  const { hasPerm, user } = useApp();
  const { data, loading, reload } = useTenantData("/auth-keys", KEYS_FALLBACK);
  const { mutate, busy } = useTenantMutation({ onError: "Failed to revoke key", reload });
  const canManage = hasPerm("manage_devices");

  const handleRevoke = async (k: AuthKeyInfo) => {
    const who = k.owner ? ` (owner @${k.owner.handle})` : "";
    if (!confirm(`Revoke auth key ${k.prefix}…${who}? Devices that have not registered with it yet will be rejected.`)) return;
    await mutate(`/auth-keys/${k.id}`, { method: "DELETE" }, { successMsg: "Auth key revoked" });
  };

  return (
    <Card title="Auth Keys">
      <p className="card-description">
        {canManage
          ? "All pre-auth keys issued for this tailnet. Revoke a key to stop it from registering new devices; already-connected devices are not affected."
          : "Pre-auth keys you have generated. Revoke a key you no longer need."}
      </p>
      {loading ? (
        <div className="loading">Loading...</div>
      ) : data.keys.length === 0 ? (
        <EmptyState>No auth keys issued.</EmptyState>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Key</th>
              <th scope="col">Owner</th>
              <th scope="col">Type</th>
              <th scope="col">Status</th>
              <th scope="col">Expires</th>
              <th scope="col">Created</th>
              <th scope="col" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {data.keys.map((k) => {
              const state = keyState(k);
              const canRevoke =
                state !== "revoked" && state !== "expired" &&
                (canManage || (!!user && k.owner?.userId === user.id));
              return (
                <tr key={k.id}>
                  <td className="mono">{k.prefix}…</td>
                  <td>{k.owner ? `@${k.owner.handle}` : "—"}</td>
                  <td>
                    <span className="btn-group">
                      <Badge variant="role">{k.reusable ? "reusable" : "single-use"}</Badge>
                      {k.ephemeral && <Badge variant="pending">ephemeral</Badge>}
                    </span>
                  </td>
                  <td>
                    {state === "active" ? (
                      <Badge variant="running">{k.used ? "active · used" : "active"}</Badge>
                    ) : state === "used" ? (
                      <Badge variant="role">used</Badge>
                    ) : (
                      <Badge variant="stopped">{state}</Badge>
                    )}
                  </td>
                  <td>{formatExpiry(k.expiresAt)}</td>
                  <td>{relativeTime(k.createdAt)}</td>
                  <td>
                    {canRevoke && (
                      <button
                        className="btn-sm btn-danger"
                        disabled={busy}
                        aria-label={`Revoke key ${k.prefix}`}
                        onClick={() => handleRevoke(k)}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}
