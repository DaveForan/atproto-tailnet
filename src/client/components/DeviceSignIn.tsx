import { useEffect, useState } from "react";
import { Card } from "./Card";
import { Loading } from "./Loading";
import { api } from "../services/api";
import { errorMessage, relativeTime } from "../lib/utils";

interface Pending {
  device: { hostname: string; os: string; fingerprint: string };
  /** When the device asked to sign in (ISO time), if the server knows. */
  requestedAt?: string | null;
  /** The address the device's request came from, if the server knows. */
  requesterIp?: string | null;
  tailnets: Array<{ id: string; name: string; blocked: string | null }>;
}

type State =
  | { kind: "loading" }
  | { kind: "gone" }
  | { kind: "ready"; data: Pending }
  | { kind: "done"; tailnet: string }
  | { kind: "denied" };

/**
 * Approval page for a device that is waiting to join (ADR-0032). The member
 * checks the device details, picks a tailnet and approves or refuses.
 */
export function DeviceSignInPage({ id, onDone }: { id: string; onDone: () => void }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [tenantId, setTenantId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    let stale = false;
    api<Pending>(`/api/device-auth/${id}`)
      .then((data) => {
        if (stale) return;
        if (!data) return setState({ kind: "gone" });
        setState({ kind: "ready", data });
        setTenantId(data.tailnets.find((t) => !t.blocked)?.id ?? "");
      })
      .catch(() => !stale && setState({ kind: "gone" }));
    return () => {
      stale = true;
    };
  }, [id]);

  const answer = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (approve) {
        const r = await api<{ tailnet: string }>(`/api/device-auth/${id}/approve`, {
          method: "POST",
          body: JSON.stringify({ tenantId, confirm: true }),
        });
        setState({ kind: "done", tailnet: r?.tailnet ?? "your tailnet" });
      } else {
        await api(`/api/device-auth/${id}/deny`, { method: "POST", body: "{}" });
        setState({ kind: "denied" });
      }
    } catch (e) {
      setError(errorMessage(e, "That did not work. The link may have expired."));
    } finally {
      setBusy(false);
    }
  };

  const back = <button type="button" className="btn-ghost mt-12" onClick={onDone}>Go to the dashboard</button>;

  return (
    <main className="access-main">
      <div className="access-page">
        {state.kind === "loading" && <Loading />}

        {state.kind === "gone" && (
          <Card title="This sign-in link is no longer valid">
            <p>It may have expired or been used already. Start the sign-in again on the device.</p>
            {back}
          </Card>
        )}

        {state.kind === "done" && (
          <Card title="Device added">
            <p role="status">The device is joining {state.tailnet}. You can close this page.</p>
            {back}
          </Card>
        )}

        {state.kind === "denied" && (
          <Card title="Sign-in refused">
            <p role="status">The device was not added.</p>
            {back}
          </Card>
        )}

        {state.kind === "ready" && (
          <Card title="Add this device to your tailnet?">
            <dl className="detail-list">
              <dt>Device</dt>
              <dd>{state.data.device.hostname}</dd>
              <dt>System</dt>
              <dd>{state.data.device.os || "unknown"}</dd>
              <dt>Key fingerprint</dt>
              <dd className="mono">{state.data.device.fingerprint}</dd>
            </dl>
            {(state.data.requestedAt || state.data.requesterIp) && (
              <p className="help-text">{requestedLine(state.data)}</p>
            )}
            <p className="notice mt-12" role="note">
              <strong>
                Only approve if you just ran <code>tailscale up</code> / logged in on this machine yourself. Someone may
                have sent you this link.
              </strong>{" "}
              A device you approve joins as one of your own devices.
            </p>
            {state.data.tailnets.length === 0 ? (
              <p className="notice" role="alert">You are not a member of a tailnet this device can join.</p>
            ) : (
              <div className="field">
                <label htmlFor="device-tailnet">Tailnet</label>
                <select id="device-tailnet" value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
                  {state.data.tailnets.map((t) => (
                    <option key={t.id} value={t.id} disabled={!!t.blocked}>
                      {t.name}{t.blocked ? " (not available)" : ""}
                    </option>
                  ))}
                </select>
                {state.data.tailnets.filter((t) => t.blocked).map((t) => (
                  <p key={t.id} className="help-text">{t.name}: {t.blocked}</p>
                ))}
              </div>
            )}
            {state.data.tailnets.length > 0 && (
              <label className="check-row mt-12">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} required />
                <span>I started this sign-in myself on this device, just now.</span>
              </label>
            )}
            {error && <p className="form-error mt-12" role="alert">{error}</p>}
            <div className="btn-group mt-16">
              <button type="button" disabled={busy || !tenantId || !confirmed} onClick={() => { void answer(true); }}>
                {busy ? "Working…" : "Add device"}
              </button>
              <button type="button" className="btn-danger btn-apart" disabled={busy} onClick={() => { void answer(false); }}>Refuse</button>
            </div>
          </Card>
        )}
      </div>
    </main>
  );
}

/** "Requested 2m ago from 203.0.113.7", with whatever parts are known. */
function requestedLine(p: Pending): string {
  const when = p.requestedAt && !Number.isNaN(Date.parse(p.requestedAt)) ? relativeTime(p.requestedAt) : null;
  if (when && p.requesterIp) return `Requested ${when} from ${p.requesterIp}`;
  if (when) return `Requested ${when}`;
  return `Requested from ${p.requesterIp}`;
}
