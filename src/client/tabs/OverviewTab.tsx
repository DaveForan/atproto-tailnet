import { Card } from "../components/Card";
import { Badge } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { Loading } from "../components/Loading";
import { LoadError } from "../components/LoadError";
import { PendingInvitations } from "../components/PendingInvitations";
import { TailnetAddressCard } from "../components/TailnetAddress";
import { useSession } from "../hooks/session";
import { useAttention } from "../hooks/useAttention";
import { useTenantParallel, type TenantLoaders } from "../hooks/useTenantData";
import { useTenantMutation } from "../hooks/useMutation";
import { deviceService } from "../services/devices";
import { usageService } from "../services/usage";
import { securityService } from "../services/security";
import { JoinRequestsGroup, WaitingDevicesGroup } from "./security/PendingCards";
import { RequestsGroup } from "./sharing/RequestsCard";
import { useTabRoute } from "../hooks/useTabRoute";
import type { SharingAct } from "./sharing/SharesCard";
import type { HealthData, UsageData } from "../lib/types";

interface OverviewData {
  health: HealthData | null;
  usage: UsageData | null;
}

const LOADERS: TenantLoaders<OverviewData> = {
  health: (tid) => deviceService.getHealth(tid),
  usage: (tid) => usageService.getUsage(tid),
};
const FALLBACK: OverviewData = { health: null, usage: null };

const withCap = (n: number, cap: number) => (cap > 0 ? `${n} / ${cap}` : String(n));

export function OverviewTab() {
  const { data, loading, error, reload } = useTenantParallel(LOADERS, FALLBACK, { keepPreviousOnReload: true });
  const { health, usage } = data;

  if (loading) return <Loading />;

  const over = usage?.overLimit;
  return (
    <div className="tab-content">
      <LoadError error={error} onRetry={reload} />
      {usage && over && (over.devices || over.members) && (
        <div className="lockdown-banner" role="alert">
          <span>
            Over limit:{" "}
            {[
              over.devices && `${usage.current.devices} devices (limit ${usage.limits.maxDevices})`,
              over.members && `${usage.current.members} members (limit ${usage.limits.maxMembers})`,
            ].filter(Boolean).join(", ")}
            . Nothing new can be added until the count drops or the limit is raised.
          </span>
        </div>
      )}
      <Card title="Tailnet">
        <div className="stats-row">
          <div className="stat-card">
            <div className="stat-value">
              <Badge variant={health?.healthy ? "running" : "stopped"}>
                {health?.healthy ? "healthy" : health ? "not reachable" : "unknown"}
              </Badge>
            </div>
            <div className="stat-label">Control server</div>
          </div>
          {usage && (
            <>
              <div className="stat-card">
                <div className="stat-value">{withCap(usage.current.devices, usage.limits.maxDevices)}</div>
                <div className="stat-label">Devices</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{usage.current.onlineDevices}</div>
                <div className="stat-label">Online</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{withCap(usage.current.members, usage.limits.maxMembers)}</div>
                <div className="stat-label">Members</div>
              </div>
            </>
          )}
        </div>
      </Card>
      <FirstDevicePrompt />
      <AttentionList onDecided={reload} />
      <TailnetAddressCard />
    </div>
  );
}

/** A member with no device here has not finished joining: point them to the next step. */
function FirstDevicePrompt() {
  const { setTab } = useTabRoute();
  const { devices, waitingMine, loading, error } = useAttention();
  if (loading || error || devices.length > 0 || waitingMine.length > 0) return null;
  return (
    <p className="notice notice-row" role="status">
      <span>You have no device in this tailnet yet. Add your phone or computer to use it.</span>
      <button type="button" className="btn-sm" onClick={() => setTab("devices", "add")}>Add a device</button>
    </p>
  );
}

/** Where pending requests are answered. Services wait in their own queue on the Services page. */
function AttentionList({ onDecided }: { onDecided: () => Promise<void> }) {
  const { reloadInvitations, reloadTenants } = useSession();
  const { setTab } = useTabRoute();
  const attention = useAttention();
  const { mutate, busy } = useTenantMutation({
    onError: "That did not work",
    reload: async () => { await Promise.all([attention.reload(), onDecided()]); },
  });
  const act: SharingAct = (action, done) => { void mutate(action, { successMsg: done }); };
  const posts = attention.posts.length;

  return (
    <Card title="Needs your attention">
      <LoadError error={attention.error} onRetry={attention.reload} />
      {attention.count === 0 && attention.waitingMine.length === 0 && !attention.error && <EmptyState>Nothing is waiting for you.</EmptyState>}
      <PendingInvitations
        invitations={attention.invitations}
        onAction={() => { void reloadInvitations(); void reloadTenants(); }}
      />
      {attention.waitingMine.length + attention.waitingQueue.length > 0 && (
        <WaitingDevicesGroup
          mine={attention.waitingMine}
          queue={attention.waitingQueue}
          busy={busy}
          onDecide={(id, action) =>
            act(
              (tid) => (action === "approve" ? deviceService.admitDevice(tid, id) : deviceService.refuseDevice(tid, id)),
              action === "approve" ? "Device admitted" : "Device refused and removed",
            )
          }
        />
      )}
      {attention.joinRequests.length > 0 && (
        <JoinRequestsGroup
          requests={attention.joinRequests}
          busy={busy}
          onDecide={(id, action) =>
            act(
              (tid) => (action === "approve" ? securityService.approveJoin(tid, id) : securityService.rejectJoin(tid, id)),
              action === "approve" ? "Join request approved" : "Join request rejected",
            )
          }
        />
      )}
      {posts > 0 && (
        <section className="item-group" aria-label="Services waiting for approval">
          <h4 className="group-heading">Services waiting for approval</h4>
          <ul className="item-list">
            <li className="item-row">
              <span className="item-name">
                {posts === 1 ? "1 service waits" : `${posts} services wait`} in the approval queue
              </span>
              <button type="button" className="btn-sm" onClick={() => setTab("board", "queue")}>Open the queue</button>
            </li>
          </ul>
        </section>
      )}
      <RequestsGroup
        incoming={attention.friendRequests}
        waiting={attention.shares}
        devices={attention.devices}
        act={act}
        busy={busy}
      />
    </Card>
  );
}
