import { useSession } from "../hooks/session";
import { useTenantParallel, type TenantLoaders } from "../hooks/useTenantData";
import { useTenantMutation, type TenantAction } from "../hooks/useMutation";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { Loading } from "../components/Loading";
import { LoadError } from "../components/LoadError";
import {
  boardsService,
  type MyDevice,
  type MyPost,
  type PendingPost,
  type PublicPost,
} from "../services/boards";
import { PublicPostCard } from "./boards/PublicPostCard";
import { PendingPostsCard } from "./boards/PendingPostsCard";
import { MyPublicServicesCard, PrivateBoardCard } from "./boards/MyServicesCards";
import { NewServiceForm } from "./boards/NewServiceForm";
import { ControllerBoardEditor } from "./boards/ControllerBoardEditor";
import { DeviceAccessCard } from "./boards/DeviceAccessCard";

interface BoardsData {
  devices: { devices: MyDevice[]; supported: boolean };
  publicBoard: { posts: PublicPost[] };
  mine: { baseDomain: string; httpsServices: boolean; serviceDomain: string | null; posts: MyPost[] };
  pending: { posts: PendingPost[] };
  mode: { mode: "open" | "member"; canEdit: boolean };
  board: { text: string; canEdit: boolean; address: string };
}

const FALLBACK: BoardsData = {
  devices: { devices: [], supported: false },
  publicBoard: { posts: [] },
  mine: { baseDomain: "", httpsServices: false, serviceDomain: null, posts: [] },
  pending: { posts: [] },
  mode: { mode: "open", canEdit: false },
  board: { text: "", canEdit: false, address: "" },
};

export function BoardsTab() {
  const { hasPerm } = useSession();
  const canReview = hasPerm("approve_services");
  const loaders: TenantLoaders<BoardsData> = {
    devices: (tid) => boardsService.myDevices(tid),
    publicBoard: (tid) => boardsService.publicBoard(tid),
    mine: (tid) => boardsService.myPosts(tid),
    pending: (tid) => (canReview ? boardsService.pending(tid) : Promise.resolve({ posts: [] })),
    mode: (tid) => boardsService.accessMode(tid),
    board: (tid) => boardsService.controllerBoard(tid),
  };
  const { data, loading, error, reload } = useTenantParallel(loaders, FALLBACK, {
    deps: [canReview],
    keepPreviousOnReload: true,
  });
  const { mutate, busy } = useTenantMutation({ reload });

  if (loading) return <Loading />;

  const act = (action: TenantAction, done: string, fail: string) => {
    void mutate(action, { successMsg: done, errorMsg: fail });
  };
  const mine = (board: "public" | "private") => data.mine.posts.filter((p) => p.board === board);
  const remove = (postId: string) => act((tid) => boardsService.remove(tid, postId), "Removed", "Could not remove");

  return (
    <div className="tab-content">
      <LoadError error={error} onRetry={reload} />
      {!data.devices.supported && (
        <Card>
          <p>Boards open ports between devices only with the coordinator control plane. This instance uses the legacy mode.</p>
        </Card>
      )}

      <Card title="Public board">
        <p className="card-description">
          Services that members offer to this tailnet. Connect the devices you choose; each one then reaches that
          service&apos;s one port.
          {data.mode.mode === "open" && " This tailnet is in open mode, so every device can already reach every device."}
        </p>
        {data.publicBoard.posts.length === 0 ? (
          <EmptyState>No services are offered yet.</EmptyState>
        ) : (
          <ul className="post-list">
            {data.publicBoard.posts.map((p) => (
              <PublicPostCard key={`${p.id}:${p.myConnectedDevices.join(",")}`} post={p} devices={data.devices.devices} onChanged={() => { void reload(); }} />
            ))}
          </ul>
        )}
      </Card>

      {canReview && data.pending.posts.length > 0 && (
        <PendingPostsCard
          posts={data.pending.posts}
          busy={busy}
          onApprove={(postId) => { act((tid) => boardsService.approve(tid, postId), "Approved", "Could not approve"); }}
          onReject={(postId, reason) => { act((tid) => boardsService.reject(tid, postId, reason), "Not approved", "Could not reject"); }}
        />
      )}

      <PrivateBoardCard posts={mine("private")} baseDomain={data.mine.baseDomain} serviceDomain={data.mine.serviceDomain} onRemove={remove} busy={busy} />

      <MyPublicServicesCard
        onChanged={() => { void reload(); }}
        posts={mine("public")}
        onRemove={remove}
        busy={busy}
        onDisconnect={(postId, userId) => { act((tid) => boardsService.disconnectMember(tid, postId, userId), "Disconnected", "Could not disconnect"); }}
      />

      <Card title="Add a service">
        <NewServiceForm devices={data.devices.devices} baseDomain={data.mine.baseDomain} serviceDomain={data.mine.serviceDomain} httpsServices={data.mine.httpsServices} onCreated={() => { void reload(); }} onDeviceAdded={() => { void reload(); }} />
      </Card>

      {data.board.canEdit && (
        <Card title="Controller board">
          <p className="card-description">
            The public page of this tailnet: its purpose, how to join, contact details. Anyone on the internet can read it.
          </p>
          <ControllerBoardEditor key={data.board.text} initial={data.board.text} address={data.board.address} onSaved={() => { void reload(); }} />
        </Card>
      )}

      {data.mode.canEdit && data.devices.supported && (
        <DeviceAccessCard
          mode={data.mode.mode}
          busy={busy}
          onChange={(next) => { act((tid) => boardsService.setAccessMode(tid, next), "Access mode changed", "Could not change the access mode"); }}
        />
      )}
    </div>
  );
}
