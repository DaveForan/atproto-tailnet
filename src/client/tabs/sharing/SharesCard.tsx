import { Card } from "../../components/Card";
import { Badge } from "../../components/Badge";
import { EmptyState } from "../../components/EmptyState";
import { sharingService, describePorts, type Person, type Share } from "../../services/sharing";
import type { TenantAction } from "../../hooks/useMutation";

/** Runs a sharing change with a success toast, then reloads the tab. */
export type SharingAct = (action: TenantAction, done: string) => void;

export const who = (p: Person) => (p.handle ? `@${p.handle}` : "a member");

export function ShareRow({ share, act, busy }: { share: Share; act: SharingAct; busy: boolean }) {
  const mine = share.role === "owner";
  return (
    <li className="post-card">
      <div className="post-head">
        <h4>
          {mine
            ? `${who(share.other)} → my ${share.ownerDeviceName ?? "device"}`
            : `My devices → a device of ${who(share.other)}`}
        </h4>
        <Badge variant={share.status === "active" ? "running" : share.status === "expired" ? "stopped" : "pending"}>
          {share.status === "requested" ? "requested" : share.status === "offered" ? "offered" : share.status}
        </Badge>
      </div>
      <p className="mono text-sm">{describePorts(share.ports)}</p>
      {share.expiresAt && <p className="text-dim text-sm">Ends {new Date(share.expiresAt).toLocaleString()}</p>}
      {share.awaitingMe && (
        <p className="help-text">
          {mine ? "Accepting opens these ports on your device to this friend." : "Accepting lets your devices reach these ports."}
        </p>
      )}
      <div className="btn-group">
        {share.awaitingMe && (
          <button type="button" className="btn-sm" disabled={busy} onClick={() => act((tid) => sharingService.acceptShare(tid, share.id), "Accepted")}>
            Accept
          </button>
        )}
        <button type="button"
          className="btn-sm btn-ghost"
          disabled={busy}
          onClick={() => act((tid) => sharingService.endShare(tid, share.id), share.status === "active" ? "Share ended" : "Removed")}
        >
          {share.status === "active" ? "End share" : share.awaitingMe ? "Decline" : "Cancel"}
        </button>
      </div>
    </li>
  );
}

/** Shares that do not wait for this user. */
export function SharesCard({ shares, act, busy }: { shares: Share[]; act: SharingAct; busy: boolean }) {
  return (
    <Card title="Shares">
      <p className="card-description">
        Access between you and a friend, one device at a time. Either of you can end a share at any moment.
      </p>
      {shares.length === 0 ? (
        <EmptyState>No shares.</EmptyState>
      ) : (
        <ul className="post-list">
          {shares.map((s) => (
            <ShareRow key={s.id} share={s} act={act} busy={busy} />
          ))}
        </ul>
      )}
    </Card>
  );
}
