import { Card } from "../../components/Card";
import { Badge } from "../../components/Badge";
import { EmptyState } from "../../components/EmptyState";
import { useConfirm } from "../../components/ConfirmDialog";
import { boardsService } from "../../services/boards";
import { sharingService, describePorts, type MyAccess, type ReachEntry } from "../../services/sharing";
import { who, type SharingAct } from "./SharesCard";

function entryText(e: ReachEntry): string {
  const from = e.devices === "all" ? `all devices of ${who(e.member)}` : `${who(e.member)}: ${e.devices.join(", ")}`;
  const why = e.kind === "service" ? `connected to your service "${e.title ?? "service"}"` : "a share";
  return `${from} (${why})`;
}

/** For each of my devices: who else can reach it, on which ports, and why. Also my own choice in an open tailnet. */
export function ReachCard({ access, act, busy }: { access: MyAccess; act: SharingAct; busy: boolean }) {
  const confirm = useConfirm();
  const { mode, open, openMembers, devices } = access;
  const others = openMembers === 1 ? "1 other member" : `${openMembers} other members`;
  return (
    <Card title="Who can reach my devices">
      <p className="card-description">
        Your own devices always reach each other. Everyone else is listed here. Only you can open your devices to someone:
        no admin of this tailnet or of this instance can.
      </p>
      {mode === "open" && (
        <div className="post-card">
          <div className="post-head">
            <h4>The tailnet&apos;s open policy</h4>
            <Badge variant={open ? "pending" : "stopped"}>{open ? "my devices follow it" : "my devices do not follow it"}</Badge>
          </div>
          <p className="help-text">
            {open
              ? `Your devices and the devices of ${others} who chose this reach each other, on every port or as the tailnet's ACL policy says.`
              : "This tailnet has an open policy for members who choose it. Your devices are not in it: only the entries below reach them."}
          </p>
          <div className="btn-group">
            <button
              type="button"
              className="btn-sm btn-ghost"
              disabled={busy}
              onClick={async () => {
                if (!open && !(await confirm({
                  title: "Put my devices under the open policy?",
                  message: "The devices of every member who chose this will reach all your devices, on every port or as the tailnet's ACL policy says. The admins of the tailnet can change that policy. You can leave at any time.",
                  confirmLabel: "Open my devices",
                }))) return;
                act((tid) => boardsService.setMyOpenAccess(tid, !open), open ? "Your devices left the open policy" : "Your devices follow the open policy");
              }}
            >
              {open ? "Take my devices out" : "Put my devices under it"}
            </button>
          </div>
        </div>
      )}
      {devices.length === 0 ? (
        <EmptyState>You have no devices in this tailnet.</EmptyState>
      ) : (
        <ul className="post-list">
          {devices.map((d) => (
            <li key={d.id} className="post-card">
              <div className="post-head">
                <h4>{d.name}</h4>
                <Badge variant={open ? "pending" : d.entries.length > 0 ? "running" : "stopped"}>
                  {open ? "open policy" : d.entries.length > 0 ? "shared" : "only me"}
                </Badge>
              </div>
              {d.entries.length > 0 && (
                <ul className="reach-list">
                  {d.entries.map((e) => (
                    <li key={`${e.kind}-${e.id}-${e.member.userId}`}>
                      <span className="mono text-sm">{describePorts(e.ports)}</span>
                      <span className="text-sm"> — {entryText(e)}</span>
                      {e.expiresAt && <span className="text-dim text-sm"> until {new Date(e.expiresAt).toLocaleString()}</span>}
                    </li>
                  ))}
                </ul>
              )}
              {d.entries.some((e) => e.kind === "share") && (
                <div className="btn-group">
                  <button
                    type="button"
                    className="btn-sm btn-ghost"
                    disabled={busy}
                    onClick={async () => {
                      if (!(await confirm({ title: `Stop sharing ${d.name}?`, message: "All shares of this device end at once. Connections to your services stay.", confirmLabel: "Stop sharing" }))) return;
                      act((tid) => sharingService.stopSharingDevice(tid, d.id), "Shares of this device ended");
                    }}
                  >
                    Stop sharing this device
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
