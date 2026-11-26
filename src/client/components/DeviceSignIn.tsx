import { useCallback, useEffect, useRef, useState } from "react";
import { Card } from "./Card";
import { Loading } from "./Loading";
import { PendingInvitations } from "./PendingInvitations";
import { JoinDefaultTailnet } from "./AccessPages";
import { useSession } from "../hooks/session";
import { deviceAuthService, type PendingDeviceSignIn } from "../services/device-auth";
import { errorMessage, relativeTime } from "../lib/utils";

type State =
  | { kind: "loading" }
  | { kind: "gone" }
  | { kind: "ready"; data: PendingDeviceSignIn }
  | { kind: "done"; tailnet: string; waiting: boolean }
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

  const { invitations, reload } = useSession();
  // Only the answer to the newest request counts: a membership can change while the page is open
  const latest = useRef(0);

  const load = useCallback(() => {
    const turn = ++latest.current;
    deviceAuthService
      .get(id)
      .then((data) => {
        if (turn !== latest.current) return;
        if (!data) return setState({ kind: "gone" });
        setState({ kind: "ready", data });
        setTenantId(data.tailnets.find((t) => !t.blocked)?.id ?? "");
      })
      .catch(() => turn === latest.current && setState({ kind: "gone" }));
  }, [id]);

  useEffect(() => {
    load();
    return () => { latest.current++; };
  }, [load]);

  const answer = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (approve) {
        const r = await deviceAuthService.approve(id, tenantId);
        setState({ kind: "done", tailnet: r?.tailnet ?? "your tailnet", waiting: r?.status === "waiting_for_approver" });
      } else {
        await deviceAuthService.deny(id);
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
          <Card title={state.waiting ? "Device admitted by you" : "Device added"}>
            {state.waiting ? (
              <p role="status">
                You admitted the device to {state.tailnet}. It has no access yet: another member, an approver of the
                tailnet, must admit it too. The device connects by itself after that. You can close this page.
              </p>
            ) : (
              <p role="status">The device is joining {state.tailnet}. You can close this page.</p>
            )}
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
                Only approve if you started the sign-in on this device yourself, just now. Someone may have sent you
                this link.
              </strong>{" "}
              A device you approve joins as one of your own devices.
            </p>
            {state.data.tailnets.length === 0 ? (
              <div className="mt-12">
                <p className="notice" role="status">
                  You are not a member of a tailnet yet, so this device has nowhere to join.{" "}
                  {invitations.length > 0
                    ? "Accept your invitation below, then add the device."
                    : "Ask to join below. After an admin approves you, start the sign-in on the device again."}
                </p>
                <PendingInvitations invitations={invitations} onAction={() => { void reload(); load(); }} />
                {invitations.length === 0 && <JoinDefaultTailnet hasInvitations={false} />}
              </div>
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
                {state.data.tailnets.find((t) => t.id === tenantId)?.needsApprover && (
                  <p className="help-text">After you add the device, another member, an approver of this tailnet, must admit it too.</p>
                )}
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
function requestedLine(p: PendingDeviceSignIn): string {
  const when = p.requestedAt && !Number.isNaN(Date.parse(p.requestedAt)) ? relativeTime(p.requestedAt) : null;
  if (when && p.requesterIp) return `Requested ${when} from ${p.requesterIp}`;
  if (when) return `Requested ${when}`;
  return `Requested from ${p.requesterIp}`;
}
