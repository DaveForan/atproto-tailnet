import { useSession } from "../hooks/session";
import { deviceService } from "../services/devices";
import { useTenantData } from "../hooks/useTenantData";
import { useTenantMutation } from "../hooks/useMutation";
import { Card } from "../components/Card";
import { Badge } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { Loading } from "../components/Loading";
import { useConfirm } from "../components/ConfirmDialog";
import { MachineLockCard } from "../components/MachineLock";
import { formatExpiry, relativeTime } from "../lib/utils";
import type { AuthKeyInfo, DevicesData } from "../lib/types";
import { LoadError } from "../components/LoadError";

const KEYS_FALLBACK: { keys: AuthKeyInfo[] } = { keys: [] };

export function DevicesTab() {
  const { hasPerm, reload, user, currentTenant } = useSession();
  const { data: devices, loading, error, reload: reloadDevices } = useTenantData<DevicesData | null>(
    (tid) => deviceService.getDevices(tid),
    null,
  );
  const { mutate, busy } = useTenantMutation({ onError: "Failed to remove device" });
  const canManage = hasPerm("manage_devices");
  const confirm = useConfirm();

  const handleRemove = async (deviceId: string, deviceName: string) => {
    if (!(await confirm({ title: `Remove device "${deviceName}"?`, message: "This cannot be undone.", confirmLabel: "Remove device", danger: true }))) return;
    await mutate(
      (tid) => deviceService.removeDevice(tid, deviceId),
      { successMsg: "Device removed", reload: async () => { await reloadDevices(); reload(); } },
    );
  };

  if (loading) return <Loading />;

  return (
    <div className="tab-content">
      <LoadError error={error} onRetry={reloadDevices} />
      <Card title="Devices">
        {error && !devices ? (
          <p className="help-text">The device list could not be loaded.</p>
        ) : !devices || devices.byUser.length === 0 ? (
          <EmptyState>
            No devices connected. Use the Add device tab to connect your first device.
          </EmptyState>
        ) : (
          devices.byUser.map((group) => (
            <section key={group.hsUsername} className="item-group" aria-label={`Devices of ${group.hsUsername}`}>
              <h4 className="group-heading">{group.hsUsername}</h4>
              <ul className="item-list">
                {group.devices.map((device) => {
                  const name = device.givenName || device.name;
                  const canRemove = canManage || (!!user && device.owner?.userId === user.id);
                  return (
                    <li key={device.id} className="item-row">
                      <div className="item-lead">
                        <span className={`online-dot ${device.online ? "online" : "offline"}`} aria-hidden="true" />
                        <div className="item-info">
                          <span className="item-name">
                            {name}
                            <span className="sr-only"> ({device.online ? "online" : "offline"})</span>
                          </span>
                          <span className="item-detail mono">{device.ipAddresses.join(", ")}</span>
                          <span className="item-detail">
                            Owner: {device.owner ? `@${device.owner.handle}` : "—"}
                          </span>
                        </div>
                      </div>
                      {canRemove && (
                        <button
                          type="button"
                          className="btn-sm btn-danger"
                          disabled={busy}
                          aria-label={`Remove device ${name}`}
                          onClick={() => handleRemove(device.id, name)}
                        >
                          Remove
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </Card>
      {currentTenant && (
        <MachineLockCard tenantId={currentTenant.id} onChanged={() => { void reloadDevices(); reload(); }} />
      )}
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
  const { hasPerm, user } = useSession();
  const { data, loading, error, reload } = useTenantData((tid) => deviceService.listAuthKeys(tid), KEYS_FALLBACK);
  const { mutate, busy } = useTenantMutation({ onError: "Failed to revoke key", reload });
  const canManage = hasPerm("manage_devices");
  const confirm = useConfirm();

  const handleRevoke = async (k: AuthKeyInfo) => {
    const who = k.owner ? ` (owner @${k.owner.handle})` : "";
    if (!(await confirm({
      title: `Revoke auth key ${k.prefix}…${who}?`,
      message: "Devices that have not registered with it yet will be rejected.",
      confirmLabel: "Revoke key",
      danger: true,
    }))) return;
    await mutate((tid) => deviceService.revokeAuthKey(tid, k.id), { successMsg: "Auth key revoked" });
  };

  return (
    <Card title="Auth keys">
      <p className="card-description">
        {canManage
          ? "All pre-auth keys issued for this tailnet. Revoke a key to stop it from registering new devices; already-connected devices are not affected."
          : "Pre-auth keys you have generated. Revoke a key you no longer need."}
      </p>
      <LoadError error={error} onRetry={reload} />
      {loading ? (
        <Loading />
      ) : error && data.keys.length === 0 ? null : data.keys.length === 0 ? (
        <EmptyState>No auth keys issued.</EmptyState>
      ) : (
        <div className="table-wrap">
        <table className="data-table stack">
          <caption className="sr-only">Auth keys issued for this tailnet</caption>
          <thead>
            <tr>
              <th scope="col">Key</th>
              <th scope="col">Owner</th>
              <th scope="col">Type</th>
              <th scope="col">Status</th>
              <th scope="col">Expires</th>
              <th scope="col">Created</th>
              <th scope="col"><span className="sr-only">Actions</span></th>
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
                  <td data-label="Key" className="mono">{k.prefix}…</td>
                  <td data-label="Owner">{k.owner ? `@${k.owner.handle}` : "—"}</td>
                  <td data-label="Type">
                    <span className="badge-stack">
                      <Badge variant="role">{k.reusable ? "reusable" : "single-use"}</Badge>
                      {k.ephemeral && <Badge variant="pending">ephemeral</Badge>}
                    </span>
                  </td>
                  <td data-label="Status">
                    {state === "active" ? (
                      <Badge variant="running">{k.used ? "active · used" : "active"}</Badge>
                    ) : state === "used" ? (
                      <Badge variant="role">used</Badge>
                    ) : (
                      <Badge variant="stopped">{state}</Badge>
                    )}
                  </td>
                  <td data-label="Expires">{formatExpiry(k.expiresAt)}</td>
                  <td data-label="Created">{relativeTime(k.createdAt)}</td>
                  <td className="cell-actions">
                    {canRevoke && (
                      <button
                        type="button"
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
        </div>
      )}
    </Card>
  );
}
