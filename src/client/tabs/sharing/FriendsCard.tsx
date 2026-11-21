import { useState } from "react";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { useConfirm } from "../../components/ConfirmDialog";
import { sharingService, type FriendsData, type Person } from "../../services/sharing";
import { who, type SharingAct } from "./SharesCard";

/** Friends, sent requests, adding a friend and blocked members. */
export function FriendsCard({
  friends,
  candidates,
  act,
  busy,
}: {
  friends: FriendsData;
  candidates: Person[];
  act: SharingAct;
  busy: boolean;
}) {
  const confirm = useConfirm();
  const [pick, setPick] = useState("");
  const known = new Set([...friends.friends, ...friends.incoming, ...friends.outgoing, ...friends.blocked].map((p) => p.userId));
  const addable = candidates.filter((c) => !known.has(c.userId));

  return (
    <Card title="Friends">
      {friends.friends.length === 0 ? (
        <EmptyState>No friends yet.</EmptyState>
      ) : (
        <ul className="item-list">
          {friends.friends.map((p) => (
            <li key={p.id} className="item-row">
              <span>{who(p)}{p.displayName ? ` · ${p.displayName}` : ""}</span>
              <span className="btn-group">
                <button type="button"
                  className="btn-sm btn-ghost"
                  disabled={busy}
                  onClick={async () => {
                    if (await confirm({
                      title: `End your friendship with ${who(p)}?`,
                      message: "Every share between you ends too.",
                      confirmLabel: "End friendship",
                      danger: true,
                    })) {
                      act((tid) => sharingService.removeFriend(tid, p.id!), "Friendship ended");
                    }
                  }}
                >
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {friends.outgoing.length > 0 && (
        <>
          <h4 className="list-heading">Requests you sent</h4>
          <ul className="item-list">
            {friends.outgoing.map((p) => (
              <li key={p.id} className="item-row">
                <span>{who(p)}</span>
                <button type="button" className="btn-sm btn-ghost" disabled={busy} onClick={() => act((tid) => sharingService.removeFriend(tid, p.id!), "Request cancelled")}>Cancel</button>
              </li>
            ))}
          </ul>
        </>
      )}
      {addable.length > 0 && (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            const id = pick || addable[0].userId;
            act((tid) => sharingService.requestFriend(tid, id), "Friend request sent");
          }}
        >
          <label htmlFor="add-friend" className="text-sm">Add a friend</label>
          <select id="add-friend" value={pick || addable[0].userId} onChange={(e) => setPick(e.target.value)}>
            {addable.map((c) => (
              <option key={c.userId} value={c.userId}>{who(c)}</option>
            ))}
          </select>
          <button type="submit" className="btn-sm" disabled={busy}>Send request</button>
        </form>
      )}
      {friends.blocked.length > 0 && (
        <>
          <h4 className="list-heading">Blocked</h4>
          <ul className="item-list">
            {friends.blocked.map((p) => (
              <li key={p.userId} className="item-row">
                <span>{who(p)}</span>
                <button type="button" className="btn-sm btn-ghost" disabled={busy} onClick={() => act((tid) => sharingService.unblock(tid, p.userId), "Unblocked")}>Unblock</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
