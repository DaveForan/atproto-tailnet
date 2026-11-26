import { formatExpiry, relativeTime } from "../../lib/utils";
import type { DeviceApproval, JoinRequest, WaitingDevice } from "../../lib/types";

type Decide = (id: string, action: "approve" | "reject") => void;

/**
 * Devices that wait for admission. `mine` are the caller's own: only the owner admits them.
 * `queue` are devices that their owners admitted and that wait for the caller as an approver.
 */
export function WaitingDevicesGroup({ mine, queue, busy, onDecide }: { mine: WaitingDevice[]; queue: WaitingDevice[]; busy: boolean; onDecide: Decide }) {
  const row = (d: WaitingDevice, own: boolean) => {
    const { canAdmit } = d;
    return (
      <li key={d.id} className="item-row">
        <div className="item-info">
          <span className="item-name">{d.name}</span>
          <span className="item-detail">
            {own ? "Your device" : d.owner ? `Device of @${d.owner.handle}` : "Device without an owner"}
            {d.os ? ` · ${d.os}` : ""}
          </span>
          <span className="item-detail">
            Key fingerprint <span className="mono">{d.fingerprint || "unknown"}</span>
          </span>
          {d.expiresAt && (
            <span className="item-detail">
              {new Date(d.expiresAt).getTime() > Date.now() ? `Removed if not admitted ${formatExpiry(d.expiresAt)}` : "Waited too long: it is removed in a moment"}
            </span>
          )}
          {!canAdmit && <span className="item-meta">You admitted it. It now waits for another member, an approver of the tailnet.</span>}
        </div>
        <div className="item-actions">
          {canAdmit && (
            <button type="button" className="btn-sm" aria-label={`Admit ${d.name}`} onClick={() => onDecide(d.id, "approve")} disabled={busy}>
              Admit
            </button>
          )}
          <button type="button" className="btn-sm btn-danger" aria-label={`Refuse ${d.name}`} onClick={() => onDecide(d.id, "reject")} disabled={busy}>
            Refuse
          </button>
        </div>
      </li>
    );
  };
  return (
    <section className="item-group" aria-label="Devices waiting to be admitted">
      <h4 className="group-heading">Devices waiting to be admitted</h4>
      <p className="help-text">
        A new device has no access until it is admitted. Admit a device only if you added it yourself, and the name and
        fingerprint match that device. Refuse any device that you do not know.
      </p>
      <ul className="item-list">
        {mine.map((d) => row(d, true))}
        {queue.map((d) => row(d, false))}
      </ul>
    </section>
  );
}

export function DeviceApprovalsGroup({ approvals, busy, onDecide }: { approvals: DeviceApproval[]; busy: boolean; onDecide: Decide }) {
  return (
    <section className="item-group" aria-label="Devices waiting for approval">
      <h4 className="group-heading">Devices waiting for approval</h4>
        <ul className="item-list">
          {approvals.map((da) => (
            <li key={da.id} className="item-row">
              <div className="item-info">
                <span className="item-name">
                  {da.requesterDisplayName || da.requesterHandle}
                </span>
                <span className="item-detail">@{da.requesterHandle} asks to add a device</span>
                <span className="item-meta">{relativeTime(da.requestedAt)}</span>
              </div>
              <div className="item-actions">
                <button
                  type="button"
                  className="btn-sm"
                  aria-label={`Approve ${da.requesterDisplayName || da.requesterHandle}`}
                  onClick={() => onDecide(da.id, "approve")}
                  disabled={busy}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="btn-sm btn-danger"
                  aria-label={`Reject ${da.requesterDisplayName || da.requesterHandle}`}
                  onClick={() => onDecide(da.id, "reject")}
                  disabled={busy}
                >
                  Reject
                </button>
              </div>
            </li>
          ))}
        </ul>
    </section>
  );
}

export function JoinRequestsGroup({ requests, busy, onDecide }: { requests: JoinRequest[]; busy: boolean; onDecide: Decide }) {
  return (
    <section className="item-group" aria-label="People asking to join">
      <h4 className="group-heading">People asking to join</h4>
        <ul className="item-list">
          {requests.map((jr) => (
            <li key={jr.id} className="item-row">
              <div className="item-info">
                <span className="item-name">
                  {jr.requesterDisplayName || jr.requesterHandle}
                </span>
                <span className="item-detail">@{jr.requesterHandle}</span>
                {jr.message && (
                  <span className="item-detail">{jr.message}</span>
                )}
                <span className="item-meta">
                  {relativeTime(jr.requestedAt)}
                </span>
              </div>
              <div className="item-actions">
                <button
                  type="button"
                  className="btn-sm"
                  aria-label={`Approve ${jr.requesterDisplayName || jr.requesterHandle}`}
                  onClick={() => onDecide(jr.id, "approve")}
                  disabled={busy}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="btn-sm btn-danger"
                  aria-label={`Reject ${jr.requesterDisplayName || jr.requesterHandle}`}
                  onClick={() => onDecide(jr.id, "reject")}
                  disabled={busy}
                >
                  Reject
                </button>
              </div>
            </li>
          ))}
        </ul>
    </section>
  );
}
