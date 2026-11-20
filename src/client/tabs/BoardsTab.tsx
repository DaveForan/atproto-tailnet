import { useCallback, useEffect, useState } from "react";
import { useSession } from "../hooks/session";
import { useToast } from "../components/Toast";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
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

interface State {
  devices: MyDevice[];
  supported: boolean;
  publicPosts: PublicPost[];
  myPosts: MyPost[];
  baseDomain: string;
  httpsServices: boolean;
  pending: PendingPost[];
  mode: "open" | "member";
  canEditMode: boolean;
  board: { text: string; canEdit: boolean; address: string };
}

export function BoardsTab() {
  const { currentTenant, hasPerm } = useSession();
  const { toast, toastFailure } = useToast();
  const [state, setState] = useState<State | null>(null);
  const [failed, setFailed] = useState(false);
  const canReview = hasPerm("approve_services");
  const tid = currentTenant?.id;

  const load = useCallback(async () => {
    if (!tid) return;
    try {
      const [devices, pub, mine, mode, board, pending] = await Promise.all([
        boardsService.myDevices(tid),
        boardsService.publicBoard(tid),
        boardsService.myPosts(tid),
        boardsService.accessMode(tid),
        boardsService.controllerBoard(tid),
        canReview ? boardsService.pending(tid) : Promise.resolve({ posts: [] }),
      ]);
      setState({
        devices: devices?.devices ?? [],
        supported: devices?.supported ?? false,
        publicPosts: pub?.posts ?? [],
        myPosts: mine?.posts ?? [],
        baseDomain: mine?.baseDomain ?? "",
        httpsServices: mine?.httpsServices ?? false,
        pending: pending?.posts ?? [],
        mode: mode?.mode ?? "open",
        canEditMode: mode?.canEdit ?? false,
        board: board ?? { text: "", canEdit: false, address: "" },
      });
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [tid, canReview]);

  useEffect(() => {
    void load();
  }, [load]);

  if (failed) {
    return (
      <div className="tab-content">
        <Card>
          <p role="alert">The boards could not be loaded.</p>
          <button type="button" className="btn-sm" onClick={() => { void load(); }}>Retry</button>
        </Card>
      </div>
    );
  }
  if (!state || !tid) return <div className="loading" role="status">Loading…</div>;

  const act = async (fn: () => Promise<unknown>, done: string, fail: string) => {
    try {
      await fn();
      toast(done);
      await load();
    } catch (e) {
      toastFailure(e, fail);
    }
  };
  const mine = (board: "public" | "private") => state.myPosts.filter((p) => p.board === board);
  const remove = (postId: string) => { void act(() => boardsService.remove(tid, postId), "Removed", "Could not remove"); };

  return (
    <div className="tab-content">
      {!state.supported && (
        <Card>
          <p>Boards open ports between devices only with the coordinator control plane. This instance uses the legacy mode.</p>
        </Card>
      )}

      <Card title="Public board">
        <p className="card-description">
          Services that members offer to this tailnet. Connect the devices you choose; each one then reaches that
          service&apos;s one port.
          {state.mode === "open" && " This tailnet is in open mode, so every device can already reach every device."}
        </p>
        {state.publicPosts.length === 0 ? (
          <EmptyState>No services are offered yet.</EmptyState>
        ) : (
          <ul className="post-list">
            {state.publicPosts.map((p) => (
              <PublicPostCard key={`${p.id}:${p.myConnectedDevices.join(",")}`} post={p} devices={state.devices} onChanged={() => { void load(); }} />
            ))}
          </ul>
        )}
      </Card>

      {canReview && state.pending.length > 0 && (
        <PendingPostsCard
          posts={state.pending}
          onApprove={(postId) => { void act(() => boardsService.approve(tid, postId), "Approved", "Could not approve"); }}
          onReject={(postId, reason) => { void act(() => boardsService.reject(tid, postId, reason), "Not approved", "Could not reject"); }}
        />
      )}

      <PrivateBoardCard posts={mine("private")} baseDomain={state.baseDomain} onRemove={remove} />

      <MyPublicServicesCard
        posts={mine("public")}
        onRemove={remove}
        onDisconnect={(postId, userId) => { void act(() => boardsService.disconnectMember(tid, postId, userId), "Disconnected", "Could not disconnect"); }}
      />

      <Card title="Add a service">
        <NewServiceForm devices={state.devices} baseDomain={state.baseDomain} httpsServices={state.httpsServices} onCreated={() => { void load(); }} />
      </Card>

      {state.board.canEdit && (
        <Card title="Controller board">
          <p className="card-description">
            The public page of this tailnet: its purpose, how to join, contact details. Anyone on the internet can read it.
          </p>
          <ControllerBoardEditor key={state.board.text} initial={state.board.text} address={state.board.address} onSaved={() => { void load(); }} />
        </Card>
      )}

      {state.canEditMode && state.supported && (
        <DeviceAccessCard
          mode={state.mode}
          onChange={(next) => { void act(() => boardsService.setAccessMode(tid, next), "Access mode changed", "Could not change the access mode"); }}
        />
      )}
    </div>
  );
}
