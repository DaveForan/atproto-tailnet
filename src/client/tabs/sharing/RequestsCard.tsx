import { Card } from "../../components/Card";
import { sharingService, type Person, type Share } from "../../services/sharing";
import { ShareRow, who, type SharingAct } from "./SharesCard";
import type { MyDevice } from "../../services/boards";

/** Friend requests and shares that wait for this user's answer. */
export function RequestsCard({
  incoming,
  waiting,
  devices,
  act,
  busy,
}: {
  incoming: Person[];
  waiting: Share[];
  devices: MyDevice[];
  act: SharingAct;
  busy: boolean;
}) {
  if (incoming.length === 0 && waiting.length === 0) return null;
  return (
    <Card title="Waiting for you">
      <ul className="post-list">
        {incoming.map((p) => (
          <li key={p.id} className="post-card">
            <div className="post-head"><h4>{who(p)} wants to be friends</h4></div>
            <div className="btn-group">
              <button type="button" className="btn-sm" disabled={busy} onClick={() => act((tid) => sharingService.acceptFriend(tid, p.id!), "You are now friends")}>Accept</button>
              <button type="button" className="btn-sm btn-ghost" disabled={busy} onClick={() => act((tid) => sharingService.removeFriend(tid, p.id!), "Declined")}>Decline</button>
              <button type="button" className="btn-sm btn-ghost" disabled={busy} onClick={() => act((tid) => sharingService.block(tid, p.userId), "Blocked")}>Block</button>
            </div>
          </li>
        ))}
        {waiting.map((s) => (
          <ShareRow key={s.id} share={s} devices={devices} act={act} busy={busy} />
        ))}
      </ul>
    </Card>
  );
}
