import { useEffect, useState } from "react";
import { Card } from "./Card";
import { api } from "../services/api";
import { errorMessage } from "../lib/utils";

interface Pending {
  device: { hostname: string; os: string; fingerprint: string };
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
          body: JSON.stringify({ tenantId }),
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

  const back = <button className="btn-ghost" onClick={onDone}>Go to the dashboard</button>;

  return (
    <main className="access-main">
      <div className="access-page">
        {state.kind === "loading" && <div className="tab-loading">Loading...</div>}

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
            <p className="help-text">
              Only approve a device that you are signing in right now. A device you approve joins as one of your own
              devices.
            </p>
            {state.data.tailnets.length === 0 ? (
              <p role="alert">You are not a member of a tailnet this device can join.</p>
            ) : (
              <div className="form-stack">
                <label htmlFor="device-tailnet" className="text-sm">Tailnet</label>
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
            {error && <p role="alert">{error}</p>}
            <div className="btn-group mt-16">
              <button disabled={busy || !tenantId} onClick={() => { void answer(true); }}>
                {busy ? "Working..." : "Add device"}
              </button>
              <button className="btn-danger" disabled={busy} onClick={() => { void answer(false); }}>Refuse</button>
            </div>
          </Card>
        )}
      </div>
    </main>
  );
}
