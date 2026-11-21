import { useState } from "react";
import { Card } from "../../components/Card";
import { Badge } from "../../components/Badge";
import { EmptyState } from "../../components/EmptyState";
import { sharingService, describePorts, parsePorts, type Person, type Share } from "../../services/sharing";
import type { MyDevice } from "../../services/boards";
import type { TenantAction } from "../../hooks/useMutation";

/** Runs a sharing change with a success toast, then reloads the tab. */
export type SharingAct = (action: TenantAction, done: string) => void;

export const who = (p: Person) => (p.handle ? `@${p.handle}` : "a member");

export function ShareRow({ share, devices, act, busy }: { share: Share; devices: MyDevice[]; act: SharingAct; busy: boolean }) {
  const mine = share.role === "owner";
  // Guest answering an offer: which of my devices connect. Empty = all of them.
  const [chosen, setChosen] = useState<string[]>([]);
  // Owner answering a request: fewer ports than asked for. Empty = as asked.
  const [fewer, setFewer] = useState("");
  const narrowed = fewer.trim() ? parsePorts(fewer) : undefined;
  const guestDevices = share.guestNodeIds.map((id) => devices.find((d) => d.id === id)?.name ?? null);
  const accept = () =>
    act(
      (tid) => sharingService.acceptShare(tid, share.id, mine ? (narrowed ? { ports: narrowed } : {}) : chosen.length > 0 ? { guestNodeIds: chosen } : {}),
      mine && narrowed ? "Sent back with fewer ports" : "Accepted",
    );
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
      {!mine && share.guestNodeIds.length > 0 && (
        <p className="text-dim text-sm">
          From: {guestDevices.every(Boolean) ? guestDevices.join(", ") : `${share.guestNodeIds.length} of my devices`}
        </p>
      )}
      {mine && share.status !== "requested" && (
        <p className="text-dim text-sm">
          {share.guestNodeIds.length === 0 ? "From all devices of this friend" : `From ${share.guestNodeIds.length} of this friend's devices`}
        </p>
      )}
      {share.awaitingMe && mine && (
        <div className="field">
          <label htmlFor={`fewer-${share.id}`}>Allow fewer ports (optional)</label>
          <input
            id={`fewer-${share.id}`}
            type="text"
            value={fewer}
            placeholder="22, 443, udp:53, ping"
            onChange={(e) => setFewer(e.target.value)}
          />
          <p className="help-text">
            {fewer.trim() && !narrowed
              ? "Use port numbers or ranges separated by commas. Prefix udp: for UDP; ping for ICMP."
              : narrowed
                ? "Your friend sees the smaller list and must accept it before anything opens."
                : "Accepting opens the requested ports on your device to this friend. You can only remove ports, not add them."}
          </p>
        </div>
      )}
      {share.awaitingMe && !mine && (
        <div className="field">
          <span className="field-label">Which of my devices may connect</span>
          {devices.length === 0 ? (
            <p className="help-text">You have no devices yet. Devices you add later can use this share.</p>
          ) : (
            <ul className="chip-list">
              <li>
                <button type="button" className="chip" aria-pressed={chosen.length === 0} onClick={() => setChosen([])}>All my devices</button>
              </li>
              {devices.map((d) => (
                <li key={d.id}>
                  <button
                    type="button"
                    className="chip"
                    aria-pressed={chosen.includes(d.id)}
                    onClick={() => setChosen((c) => (c.includes(d.id) ? c.filter((x) => x !== d.id) : [...c, d.id]))}
                  >
                    {d.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="help-text">
            {chosen.length === 0
              ? "Accepting lets all your devices, also later ones, reach these ports."
              : "Accepting lets only the chosen devices reach these ports."}
          </p>
        </div>
      )}
      <div className="btn-group">
        {share.awaitingMe && (
          <button type="button" className="btn-sm" disabled={busy || (mine && Boolean(fewer.trim()) && !narrowed)} onClick={accept}>
            {mine && narrowed ? "Answer with fewer ports" : "Accept"}
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
export function SharesCard({ shares, devices, act, busy }: { shares: Share[]; devices: MyDevice[]; act: SharingAct; busy: boolean }) {
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
            <ShareRow key={s.id} share={s} devices={devices} act={act} busy={busy} />
          ))}
        </ul>
      )}
    </Card>
  );
}
