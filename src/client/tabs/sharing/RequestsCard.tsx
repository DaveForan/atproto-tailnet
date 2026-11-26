import { sharingService, type Person, type Share } from "../../services/sharing";
import { ShareRow, who, type SharingAct } from "./SharesCard";
import type { MyDevice } from "../../services/boards";

/** Friend requests and shares that wait for this user's answer. */
export function RequestsGroup({
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
    <section className="item-group" aria-label="Friend and share requests">
      <h4 className="group-heading">Friend and share requests</h4>
      <ul className="item-list">
        {incoming.map((p) => (
          <li key={p.id} className="item-row">
            <span className="item-name">{who(p)} wants to be friends</span>
            <div className="item-actions">
              <button type="button" className="btn-sm" disabled={busy} onClick={() => act((tid) => sharingService.acceptFriend(tid, p.id!), "You are now friends")}>Accept</button>
              <button type="button" className="btn-sm btn-ghost" disabled={busy} onClick={() => act((tid) => sharingService.removeFriend(tid, p.id!), "Declined")}>Decline</button>
              <button type="button" className="btn-sm btn-ghost" disabled={busy} onClick={() => act((tid) => sharingService.block(tid, p.userId), "Blocked")}>Block</button>
            </div>
          </li>
        ))}
      </ul>
      {waiting.length > 0 && (
        <ul className="post-list">
          {waiting.map((s) => (
            <ShareRow key={s.id} share={s} devices={devices} act={act} busy={busy} />
          ))}
        </ul>
      )}
    </section>
  );
}
