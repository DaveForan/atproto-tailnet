import { useEffect, useState } from "react";
import { useTenant } from "../../hooks/session";
import { useTenantMutation } from "../../hooks/useMutation";
import type { MyDevice } from "../../services/boards";
import { sharingService, parsePorts, type Person } from "../../services/sharing";
import { who } from "./SharesCard";

const EXPIRY_CHOICES: Array<{ label: string; hours: number | null }> = [
  { label: "1 hour", hours: 1 },
  { label: "1 day", hours: 24 },
  { label: "1 week", hours: 24 * 7 },
  { label: "Until I end it", hours: null },
];

/** Offer a device to a friend, or ask to reach one of theirs. */
export function NewShareForm({ friends, devices, onCreated }: { friends: Person[]; devices: MyDevice[]; onCreated: () => void }) {
  const { currentTenant } = useTenant();
  const { mutate, busy } = useTenantMutation({ onError: "Could not send it" });
  const [kind, setKind] = useState<"offer" | "request">("offer");
  const [friendId, setFriendId] = useState(friends[0]?.userId ?? "");
  const [theirDevices, setTheirDevices] = useState<Array<{ id: string; name: string }>>([]);
  const [deviceId, setDeviceId] = useState("");
  const [portsText, setPortsText] = useState("");
  const [expiry, setExpiry] = useState(1);
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
    if (!valid || !ports) return;
    const ok = await mutate(
      (tid) => sharingService.createShare(tid, {
        kind,
        friendId,
        ownerNodeId: deviceId,
        ports,
        expiresInHours: EXPIRY_CHOICES[expiry].hours ?? undefined,
      }),
      { successMsg: kind === "offer" ? "Offer sent" : "Request sent" },
    );
    if (ok) {
      setPortsText("");
      onCreated();
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
