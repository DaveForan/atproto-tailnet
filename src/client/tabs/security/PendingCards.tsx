import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { relativeTime } from "../../lib/utils";
import type { DeviceApproval, JoinRequest } from "../../lib/types";

type Decide = (id: string, action: "approve" | "reject") => void;

export function DeviceApprovalsCard({ approvals, busy, onDecide }: { approvals: DeviceApproval[]; busy: boolean; onDecide: Decide }) {
  return (
    <Card title="Pending device approvals">
      {approvals.length === 0 ? (
        <EmptyState>No pending device approvals.</EmptyState>
      ) : (
        <ul className="item-list">
          {approvals.map((da) => (
            <li key={da.id} className="item-row">
              <div className="item-info">
                <span className="item-name">
                  {da.displayName || da.handle}
                </span>
                <span className="item-meta">
                  <span>Key: <span className="mono">{da.machineKey.slice(0, 16)}…</span></span>
                  <span>{relativeTime(da.createdAt)}</span>
                </span>
              </div>
              <div className="item-actions">
                <button
                  type="button"
                  className="btn-sm"
                  aria-label={`Approve ${da.displayName || da.handle}`}
                  onClick={() => onDecide(da.id, "approve")}
                  disabled={busy}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="btn-sm btn-danger"
                  aria-label={`Reject ${da.displayName || da.handle}`}
                  onClick={() => onDecide(da.id, "reject")}
                  disabled={busy}
                >
                  Reject
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function JoinRequestsCard({ requests, busy, onDecide }: { requests: JoinRequest[]; busy: boolean; onDecide: Decide }) {
  return (
    <Card title="Pending join requests">
      {requests.length === 0 ? (
        <EmptyState>No pending join requests.</EmptyState>
      ) : (
        <ul className="item-list">
          {requests.map((jr) => (
            <li key={jr.id} className="item-row">
              <div className="item-info">
                <span className="item-name">
                  {jr.userDisplayName || jr.userHandle}
                </span>
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
                  aria-label={`Approve ${jr.userDisplayName || jr.userHandle}`}
                  onClick={() => onDecide(jr.id, "approve")}
                  disabled={busy}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="btn-sm btn-danger"
                  aria-label={`Reject ${jr.userDisplayName || jr.userHandle}`}
                  onClick={() => onDecide(jr.id, "reject")}
                  disabled={busy}
                >
                  Reject
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
