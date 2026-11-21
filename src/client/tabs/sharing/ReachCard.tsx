import { Card } from "../../components/Card";
import { Badge } from "../../components/Badge";
import { EmptyState } from "../../components/EmptyState";
import { useConfirm } from "../../components/ConfirmDialog";
import { sharingService, describePorts, type DeviceReach, type ReachEntry } from "../../services/sharing";
import { who, type SharingAct } from "./SharesCard";

function entryText(e: ReachEntry): string {
  const from = e.devices === "all" ? `all devices of ${who(e.member)}` : `${who(e.member)}: ${e.devices.join(", ")}`;
  const why = e.kind === "service" ? `connected to your service "${e.title ?? "service"}"` : "a share";
  return `${from} (${why})`;
}

/** For each of my devices: who else can reach it, on which ports, and why. */
export function ReachCard({ mode, devices, act, busy }: { mode: "open" | "member"; devices: DeviceReach[]; act: SharingAct; busy: boolean }) {
  const confirm = useConfirm();
  return (
    <Card title="Who can reach my devices">
      <p className="card-description">
        {mode === "open"
          ? "This tailnet is open: every device of every member can reach every one of your devices on all ports."
          : "Your own devices always reach each other. Everyone else is listed here. A device with no entry is closed to other members."}
      </p>
      {devices.length === 0 ? (
        <EmptyState>You have no devices in this tailnet.</EmptyState>
      ) : (
        <ul className="post-list">
          {devices.map((d) => (
            <li key={d.id} className="post-card">
              <div className="post-head">
                <h4>{d.name}</h4>
                <Badge variant={mode === "open" ? "pending" : d.entries.length > 0 ? "running" : "stopped"}>
                  {mode === "open" ? "open to all" : d.entries.length > 0 ? "shared" : "only me"}
                </Badge>
              </div>
              {mode === "member" && d.entries.length > 0 && (
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
              {mode === "member" && d.entries.some((e) => e.kind === "share") && (
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
