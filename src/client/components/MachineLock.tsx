import { useCallback, useEffect, useState } from "react";
import { Card } from "./Card";
import { Badge } from "./Badge";
import { useToast } from "./Toast";
import { useConfirm } from "./ConfirmDialog";
import { errorCode, errorMessage } from "../lib/utils";
import { machineLockService, type MachineLockState } from "../services/machine-lock";

/**
 * "Lock my devices" (ADR-0035): the member limits their devices in this
 * tailnet to chosen machines. The coordinator refuses every other machine.
 */
export function MachineLockCard({ tenantId, onChanged }: { tenantId: string; onChanged?: () => void }) {
  const { toast, toastError } = useToast();
  const confirm = useConfirm();
  const [state, setState] = useState<MachineLockState | null>(null);
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);

  const apply = useCallback((s: MachineLockState | null) => {
    setState(s);
    if (s) setKeep(new Set(s.devices.filter((d) => d.allowed).map((d) => d.id)));
  }, []);

  useEffect(() => {
    machineLockService.get(tenantId).then(apply, () => setState(null));
  }, [tenantId, apply]);

  /** Run a change and show the result. */
  const run = async (fn: () => Promise<MachineLockState | null>, done: string) => {
    setBusy(true);
    try {
      apply(await fn()); // the API layer proves this device again when the server asks
      setChoosing(false);
      toast(done);
      onChanged?.();
    } catch (e) {
      toastError(
        errorCode(e) === "device_not_trusted"
          ? "This browser is not one of your trusted devices, so it cannot change the lock."
          : errorMessage(e, "That did not work"),
      );
    } finally {
      setBusy(false);
    }
  };

  if (!state || !state.supported) return null;

  const windowOpen = state.allowOneUntil !== null && new Date(state.allowOneUntil).getTime() > Date.now();
  const dropped = state.devices.filter((d) => !keep.has(d.id));

  return (
    <Card title="Lock my devices">
      {!state.locked && !choosing && (
        <>
          <p className="card-description">
            Limit your devices in this tailnet to the ones you have now. While the lock is on, no other machine can
            join as you, also with a valid auth key or the correct sign-in.
          </p>
          <button type="button" disabled={busy || state.devices.length === 0} onClick={() => setChoosing(true)}>
            Lock to my devices
          </button>
          {state.devices.length === 0 && <p className="help-text">Add a device first.</p>}
        </>
      )}

      {choosing && (
        <form
          className="form-stack"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => machineLockService.lock(tenantId, [...keep]), "Your devices are locked");
          }}
        >
          <fieldset className="check-list">
            <legend>Devices that stay</legend>
            {state.devices.map((d) => (
              <label key={d.id} className="check-row">
                <input
                  type="checkbox"
                  checked={keep.has(d.id)}
                  onChange={(e) =>
                    setKeep((k) => {
                      const next = new Set(k);
                      if (e.target.checked) next.add(d.id);
                      else next.delete(d.id);
                      return next;
                    })
                  }
                />
                <span>{d.name}</span>
                <span className="text-dim text-sm">{d.online ? "online" : "offline"}</span>
              </label>
            ))}
          </fieldset>
          {dropped.length > 0 && (
            <p className="notice" role="alert">
              {dropped.map((d) => d.name).join(", ")} will be removed from this tailnet.
            </p>
          )}
          <div className="btn-group">
            <button type="submit" disabled={busy || keep.size === 0}>Lock</button>
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => { apply(state); setChoosing(false); }}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {state.locked && !choosing && (
        <div className="form-stack">
          <p className="notice notice-ok">
            The lock is on. Only these devices can connect as you in this tailnet.
          </p>
          <ul className="item-list">
            {state.devices.map((d) => (
              <li key={d.id} className="item-row">
                <span>{d.name}</span>
                <Badge variant={d.online ? "running" : "stopped"}>{d.online ? "online" : "offline"}</Badge>
              </li>
            ))}
          </ul>
          {windowOpen ? (
            <p className="notice" role="status">
              The next new device that joins as you before{" "}
              {new Date(state.allowOneUntil!).toLocaleTimeString()} is added to the lock. Then the lock closes again.
            </p>
          ) : (
            <p className="help-text">
              To add a device, select &quot;Allow one new device&quot;, then connect it in the next 10 minutes.
            </p>
          )}
          <div className="btn-group">
            <button type="button" className="btn-sm" disabled={busy || windowOpen} onClick={() => { void run(() => machineLockService.allowOne(tenantId), "The next new device will be let in"); }}>
              Allow one new device
            </button>
            <button type="button" className="btn-sm btn-ghost" disabled={busy} onClick={() => setChoosing(true)}>
              Change devices
            </button>
            <button type="button"
              className="btn-sm btn-ghost"
              disabled={busy}
              onClick={async () => {
                if (!(await confirm({
                  title: "Turn the lock off?",
                  message: "Any machine with a valid key or sign-in can join as you again.",
                  confirmLabel: "Turn off",
                  danger: true,
                }))) return;
                void run(() => machineLockService.unlock(tenantId), "The lock is off");
              }}
            >
              Turn the lock off
            </button>
          </div>
        </div>
      )}

      {state.refused.length > 0 && (
        <>
          <h4 className="list-heading">Refused machines</h4>
          <p className="help-text">
            These machines tried to join as you while the lock was on. If you do not know them, revoke your auth keys
            and check your account.
          </p>
          <ul className="item-list">
            {state.refused.map((r) => (
              <li key={`${r.at}-${r.fingerprint}`} className="item-row">
                <span>
                  <strong>{r.hostname || "unnamed"}</strong> <span className="text-dim text-sm">{r.os}</span>
                  <br />
                  <span className="text-dim text-sm mono">{r.fingerprint}</span>
                </span>
                <span className="text-dim text-sm">{new Date(r.at).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
