import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useSession } from "./session";
import { useTenantParallel, type TenantLoaders } from "./useTenantData";
import { securityService } from "../services/security";
import { boardsService, type MyDevice, type PendingPost } from "../services/boards";
import { sharingService, type Person, type Share } from "../services/sharing";
import { deviceService } from "../services/devices";
import type { DeviceApproval, Invitation, JoinRequest, WaitingDevice, WaitingDevices } from "../lib/types";

interface Loaded {
  approvals: DeviceApproval[];
  joinRequests: JoinRequest[];
  pending: { posts: PendingPost[] };
  friends: { incoming: Person[] };
  shares: { shares: Share[] };
  devices: { devices: MyDevice[] };
  waiting: WaitingDevices;
}

export interface Attention {
  invitations: Invitation[];
  approvals: DeviceApproval[];
  joinRequests: JoinRequest[];
  posts: PendingPost[];
  friendRequests: Person[];
  shares: Share[];
  /** The caller's devices: accepting a share asks which of them to use. */
  devices: MyDevice[];
  /** The caller's own devices that wait for admission. */
  waitingMine: WaitingDevice[];
  /** Devices of other members that wait for the caller as an approver. */
  waitingQueue: WaitingDevice[];
  count: number;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

const FALLBACK: Loaded = {
  approvals: [],
  joinRequests: [],
  pending: { posts: [] },
  friends: { incoming: [] },
  shares: { shares: [] },
  devices: { devices: [] },
  waiting: { mine: [], queue: [] },
};

const REFRESH_MS = 60_000;
const AttentionCtx = createContext<Attention>(null!);

/** Everything that waits for this user's answer in the current tailnet. */
export function useAttention() {
  return useContext(AttentionCtx);
}

export function AttentionProvider({ children }: { children: ReactNode }) {
  const { invitations, hasPerm } = useSession();
  const canDevices = hasPerm("approve_devices");
  const canJoins = hasPerm("approve_joins");
  const canPosts = hasPerm("approve_services");
  const loaders: TenantLoaders<Loaded> = {
    approvals: (tid) => (canDevices ? securityService.deviceApprovals(tid) : Promise.resolve([])),
    joinRequests: (tid) => (canJoins ? securityService.joinRequests(tid) : Promise.resolve([])),
    pending: (tid) => (canPosts ? boardsService.pending(tid) : Promise.resolve({ posts: [] })),
    friends: (tid) => sharingService.friends(tid),
    shares: (tid) => sharingService.shares(tid),
    devices: (tid) => boardsService.myDevices(tid),
    waiting: (tid) => deviceService.waiting(tid),
  };
  const { data, loading, error, reload } = useTenantParallel(loaders, FALLBACK, {
    deps: [canDevices, canJoins, canPosts],
    keepPreviousOnReload: true,
  });

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);

  const value = useMemo<Attention>(() => {
    const approvals = data.approvals.filter((a) => a.status === "pending");
    const joinRequests = data.joinRequests.filter((j) => j.status === "pending");
    const posts = data.pending.posts;
    const friendRequests = data.friends.incoming;
    const shares = data.shares.shares.filter((s) => s.awaitingMe);
    const { mine: waitingMine, queue: waitingQueue } = data.waiting;
    // A device that waits for an approver needs no answer from its owner
    const mineToAnswer = waitingMine.filter((d) => d.canAdmit).length;
    return {
      invitations,
      approvals,
      joinRequests,
      posts,
      friendRequests,
      shares,
      devices: data.devices.devices,
      waitingMine,
      waitingQueue,
      count:
        invitations.length + approvals.length + joinRequests.length + posts.length + friendRequests.length + shares.length +
        mineToAnswer + waitingQueue.length,
      loading,
      error,
      reload,
    };
  }, [data, invitations, loading, error, reload]);

  return <AttentionCtx.Provider value={value}>{children}</AttentionCtx.Provider>;
}
