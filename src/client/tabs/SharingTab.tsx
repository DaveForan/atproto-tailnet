import { useCallback, useEffect, useState } from "react";
import { useApp } from "../hooks/useAppState";
import { useToast } from "../components/Toast";
import { useConfirm } from "../components/ConfirmDialog";
import { Card } from "../components/Card";
import { Badge } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { errorMessage } from "../lib/utils";
import { boardsService, type MyDevice } from "../services/boards";
import {
  sharingService,
  describePorts,
  parsePorts,
  type FriendsData,
  type Person,
  type Share,
} from "../services/sharing";

const EXPIRY_CHOICES: Array<{ label: string; hours: number | null }> = [
  { label: "1 hour", hours: 1 },
  { label: "1 day", hours: 24 },
  { label: "1 week", hours: 24 * 7 },
  { label: "Until I end it", hours: null },
];

const who = (p: Person) => (p.handle ? `@${p.handle}` : "a member");

function NewShareForm({ friends, devices, onCreated }: { friends: Person[]; devices: MyDevice[]; onCreated: () => void }) {
  const { currentTenant } = useApp();
  const { toast, toastError } = useToast();
  const [kind, setKind] = useState<"offer" | "request">("offer");
  const [friendId, setFriendId] = useState(friends[0]?.userId ?? "");
  const [theirDevices, setTheirDevices] = useState<Array<{ id: string; name: string }>>([]);
  const [deviceId, setDeviceId] = useState("");
  const [portsText, setPortsText] = useState("");
  const [expiry, setExpiry] = useState(1);
  const [busy, setBusy] = useState(false);
  const tid = currentTenant?.id;

  // The device list is mine for an offer, the friend's for a request
  useEffect(() => {
    setDeviceId("");
    if (kind === "offer") {
      setDeviceId(devices[0]?.id ?? "");
      return;
    }
    if (!tid || !friendId) return;
    let stale = false;
    sharingService
      .friendDevices(tid, friendId)
      .then((r) => {
        if (stale) return;
        setTheirDevices(r?.devices ?? []);
        setDeviceId(r?.devices[0]?.id ?? "");
      })
      .catch(() => !stale && setTheirDevices([]));
    return () => {
      stale = true;
    };
  }, [kind, friendId, tid, devices]);

  const ports = parsePorts(portsText);
  const choices = kind === "offer" ? devices.map((d) => ({ id: d.id, name: d.name })) : theirDevices;
  const valid = friendId && deviceId && ports;

  const submit = async () => {
    if (!tid || !valid || !ports) return;
    setBusy(true);
    try {
      await sharingService.createShare(tid, {
        kind,
        friendId,
        ownerNodeId: deviceId,
        ports,
        expiresInHours: EXPIRY_CHOICES[expiry].hours ?? undefined,
      });
      toast(kind === "offer" ? "Offer sent" : "Request sent");
      setPortsText("");
      onCreated();
    } catch (e) {
      toastError(errorMessage(e, "Could not send it"));
    } finally {
      setBusy(false);
    }
  };

  if (friends.length === 0) {
    return <p className="help-text">Add a friend first. Only friends can share devices.</p>;
  }

  return (
    <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <label htmlFor="share-kind">I want to</label>
      <select id="share-kind" value={kind} onChange={(e) => setKind(e.target.value as "offer" | "request")}>
        <option value="offer">Let a friend reach one of my devices</option>
        <option value="request">Ask to reach a friend&apos;s device</option>
      </select>

      <label htmlFor="share-friend">Friend</label>
      <select id="share-friend" value={friendId} onChange={(e) => setFriendId(e.target.value)}>
        {friends.map((f) => (
          <option key={f.userId} value={f.userId}>{who(f)}</option>
        ))}
      </select>

      <label htmlFor="share-device">{kind === "offer" ? "My device" : "Their device"}</label>
      {choices.length === 0 ? (
        <p className="help-text">{kind === "offer" ? "You have no devices yet." : "This friend has no devices."}</p>
      ) : (
        <select id="share-device" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
          {choices.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      )}

      <label htmlFor="share-ports">Ports</label>
      <div>
        <input
          id="share-ports"
          type="text"
          value={portsText}
          placeholder="22, 443, 8000-8010, udp:53, ping"
          onChange={(e) => setPortsText(e.target.value)}
          aria-describedby="share-ports-help"
        />
        <p id="share-ports-help" className="help-text">
          {portsText && !ports
            ? "Use port numbers or ranges separated by commas. Prefix udp: for UDP; ping for ICMP."
            : "Only these ports are opened. TCP unless you write udp:."}
        </p>
      </div>

      <label htmlFor="share-expiry">Lasts</label>
      <select id="share-expiry" value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>
        {EXPIRY_CHOICES.map((c, i) => (
          <option key={c.label} value={i}>{c.label}</option>
        ))}
      </select>

      <div className="form-actions">
        <button type="submit" disabled={busy || !valid}>{busy ? "Sending..." : kind === "offer" ? "Send offer" : "Send request"}</button>
        <p className="help-text">Nothing is opened until your friend accepts.</p>
      </div>
    </form>
  );
}

function ShareRow({ share, onChanged }: { share: Share; onChanged: () => void }) {
  const { currentTenant } = useApp();
  const { toast, toastError } = useToast();
  const tid = currentTenant?.id;
  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast(done);
      onChanged();
    } catch (e) {
      toastError(errorMessage(e, "That did not work"));
    }
  };
  if (!tid) return null;
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
          <button type="button" className="btn-sm" onClick={() => { void act(() => sharingService.acceptShare(tid, share.id), "Accepted"); }}>
            Accept
          </button>
        )}
        <button type="button"
          className="btn-sm btn-ghost"
          onClick={() => { void act(() => sharingService.endShare(tid, share.id), share.status === "active" ? "Share ended" : "Removed"); }}
        >
          {share.status === "active" ? "End share" : share.awaitingMe ? "Decline" : "Cancel"}
        </button>
      </div>
    </li>
  );
}

export function SharingTab() {
  const { currentTenant } = useApp();
  const { toast, toastError } = useToast();
  const confirm = useConfirm();
  const [friends, setFriends] = useState<FriendsData | null>(null);
  const [shares, setShares] = useState<Share[]>([]);
  const [devices, setDevices] = useState<MyDevice[]>([]);
  const [candidates, setCandidates] = useState<Person[]>([]);
  const [pick, setPick] = useState("");
  const [failed, setFailed] = useState(false);
  const tid = currentTenant?.id;

  const load = useCallback(async () => {
    if (!tid) return;
    try {
      const [f, s, d, c] = await Promise.all([
        sharingService.friends(tid),
        sharingService.shares(tid),
        boardsService.myDevices(tid),
        sharingService.candidates(tid),
      ]);
      setFriends(f ?? { friends: [], incoming: [], outgoing: [], blocked: [] });
      setShares(s?.shares ?? []);
      setDevices(d?.devices ?? []);
      setCandidates(c?.members ?? []);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [tid]);

  useEffect(() => {
    void load();
  }, [load]);

  if (failed) {
    return (
      <div className="tab-content">
        <Card>
          <p role="alert">Friends and shares could not be loaded.</p>
          <button type="button" className="btn-sm" onClick={() => { void load(); }}>Retry</button>
        </Card>
      </div>
    );
  }
  if (!friends || !tid) return <div className="loading" role="status">Loading…</div>;

  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast(done);
      await load();
    } catch (e) {
      toastError(errorMessage(e, "That did not work"));
    }
  };
  const known = new Set([...friends.friends, ...friends.incoming, ...friends.outgoing, ...friends.blocked].map((p) => p.userId));
  const addable = candidates.filter((c) => !known.has(c.userId));
  const waiting = shares.filter((s) => s.awaitingMe);
  const rest = shares.filter((s) => !s.awaitingMe);

  return (
    <div className="tab-content">
      {(friends.incoming.length > 0 || waiting.length > 0) && (
        <Card title="Waiting for you">
          <ul className="post-list">
            {friends.incoming.map((p) => (
              <li key={p.id} className="post-card">
                <div className="post-head"><h4>{who(p)} wants to be friends</h4></div>
                <div className="btn-group">
                  <button type="button" className="btn-sm" onClick={() => { void act(() => sharingService.acceptFriend(tid, p.id!), "You are now friends"); }}>Accept</button>
                  <button type="button" className="btn-sm btn-ghost" onClick={() => { void act(() => sharingService.removeFriend(tid, p.id!), "Declined"); }}>Decline</button>
                  <button type="button" className="btn-sm btn-ghost" onClick={() => { void act(() => sharingService.block(tid, p.userId), "Blocked"); }}>Block</button>
                </div>
              </li>
            ))}
            {waiting.map((s) => (
              <ShareRow key={s.id} share={s} onChanged={() => { void load(); }} />
            ))}
          </ul>
        </Card>
      )}

      <Card title="Shares">
        <p className="card-description">
          Access between you and a friend, one device at a time. Either of you can end a share at any moment.
        </p>
        {rest.length === 0 ? (
          <EmptyState>No shares.</EmptyState>
        ) : (
          <ul className="post-list">
            {rest.map((s) => (
              <ShareRow key={s.id} share={s} onChanged={() => { void load(); }} />
            ))}
          </ul>
        )}
      </Card>

      <Card title="Share a device">
        <NewShareForm friends={friends.friends} devices={devices} onCreated={() => { void load(); }} />
      </Card>

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
                    onClick={async () => {
                      if (await confirm({
                        title: `End your friendship with ${who(p)}?`,
                        message: "Every share between you ends too.",
                        confirmLabel: "End friendship",
                        danger: true,
                      })) {
                        void act(() => sharingService.removeFriend(tid, p.id!), "Friendship ended");
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
                  <button type="button" className="btn-sm btn-ghost" onClick={() => { void act(() => sharingService.removeFriend(tid, p.id!), "Request cancelled"); }}>Cancel</button>
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
              void act(() => sharingService.requestFriend(tid, id), "Friend request sent");
            }}
          >
            <label htmlFor="add-friend" className="text-sm">Add a friend</label>
            <select id="add-friend" value={pick || addable[0].userId} onChange={(e) => setPick(e.target.value)}>
              {addable.map((c) => (
                <option key={c.userId} value={c.userId}>{who(c)}</option>
              ))}
            </select>
            <button type="submit" className="btn-sm">Send request</button>
          </form>
        )}
        {friends.blocked.length > 0 && (
          <>
            <h4 className="list-heading">Blocked</h4>
            <ul className="item-list">
              {friends.blocked.map((p) => (
                <li key={p.userId} className="item-row">
                  <span>{who(p)}</span>
                  <button type="button" className="btn-sm btn-ghost" onClick={() => { void act(() => sharingService.unblock(tid, p.userId), "Unblocked"); }}>Unblock</button>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </div>
  );
}
