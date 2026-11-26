import { useSession } from "../hooks/session";
import { useAttention } from "../hooks/useAttention";
import { useTabRoute } from "../hooks/useTabRoute";
import { useTenantParallel, type TenantLoaders } from "../hooks/useTenantData";
import { useTenantMutation, type TenantAction } from "../hooks/useMutation";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { Loading } from "../components/Loading";
import { LoadError } from "../components/LoadError";
import { SubNav, useSections } from "../components/SubNav";
import { boardsService, type ChildBoard, type MyDevice, type MyPost, type PublicPost } from "../services/boards";
import { PublicPostCard } from "./boards/PublicPostCard";
import { MyPublicServicesCard, PrivateBoardCard } from "./boards/MyServicesCards";
import { NewServiceForm } from "./boards/NewServiceForm";
import { ControllerBoardEditor } from "./boards/ControllerBoardEditor";
import { BoardSettingsCard } from "./boards/BoardSettingsCard";
import { PendingPostsCard } from "./boards/PendingPostsCard";

interface BoardsData {
  devices: { devices: MyDevice[]; supported: boolean };
  publicBoard: { posts: PublicPost[] };
  mine: { baseDomain: string; httpsServices: boolean; serviceDomain: string | null; posts: MyPost[] };
  mode: { mode: "open" | "member"; canEdit: boolean };
  board: { text: string; canEdit: boolean; address: string };
  children: { tailnets: ChildBoard[] };
}

const FALLBACK: BoardsData = {
  devices: { devices: [], supported: false },
  publicBoard: { posts: [] },
  mine: { baseDomain: "", httpsServices: false, serviceDomain: null, posts: [] },
  mode: { mode: "open", canEdit: false },
  board: { text: "", canEdit: false, address: "" },
  children: { tailnets: [] },
};

const LOADERS: TenantLoaders<BoardsData> = {
  devices: (tid) => boardsService.myDevices(tid),
  publicBoard: (tid) => boardsService.publicBoard(tid),
  mine: (tid) => boardsService.myPosts(tid),
  mode: (tid) => boardsService.accessMode(tid),
  board: (tid) => boardsService.controllerBoard(tid),
  children: (tid) => boardsService.children(tid),
};

export function BoardsTab() {
  const { settings, hasPerm } = useSession();
  const { setTab } = useTabRoute();
  const attention = useAttention();
  const { data, loading, error, reload } = useTenantParallel(LOADERS, FALLBACK, { keepPreviousOnReload: true });
  const { mutate, busy } = useTenantMutation({
    reload: async () => { await Promise.all([reload(), attention.reload()]); },
  });
  // The queue stays in the menu while it holds posts from before approval was turned off
  const queueOff = !settings?.requireServiceApproval && attention.posts.length === 0;
  const { sections, open } = useSections("board", queueOff ? ["queue"] : []);

  if (loading) return <Loading />;

  const act = (action: TenantAction, done: string, fail: string) => {
    void mutate(action, { successMsg: done, errorMsg: fail });
  };
  const mine = (board: "public" | "private") => data.mine.posts.filter((p) => p.board === board);
  const remove = (postId: string) => act((tid) => boardsService.remove(tid, postId), "Removed", "Could not remove");
  const changed = () => { void reload(); void attention.reload(); };
  const boardOn = settings?.boardEnabled ?? false;

  return (
    <>
      <SubNav tab="board" label="Services sections" sections={sections} open={open} counts={{ queue: attention.posts.length }} />
      <div className="tab-content">
        <LoadError error={error} onRetry={reload} />
        {!data.devices.supported && (
          <p className="notice" role="status">
            Boards open ports between devices only with the coordinator control plane. This instance uses the legacy mode.
          </p>
        )}

        {open?.id === "mine" ? (
          <>
            <PrivateBoardCard posts={mine("private")} baseDomain={data.mine.baseDomain} serviceDomain={data.mine.serviceDomain} onRemove={remove} busy={busy} />
            <MyPublicServicesCard
              onChanged={changed}
              posts={mine("public")}
              onRemove={remove}
              busy={busy}
              onDisconnect={(postId, userId) => { act((tid) => boardsService.disconnectMember(tid, postId, userId), "Disconnected", "Could not disconnect"); }}
            />
            <Card title="Add a service">
              <p className="card-description">
                {!boardOn
                  ? "The public board is off in this tailnet, so a new service is for your own devices."
                  : settings?.requireServiceApproval
                    ? "A private service is for your own devices. A public service shows on the board after an approver accepts it."
                    : "A private service is for your own devices. A public service shows on the board immediately."}
              </p>
              <NewServiceForm devices={data.devices.devices} baseDomain={data.mine.baseDomain} serviceDomain={data.mine.serviceDomain} httpsServices={data.mine.httpsServices} onCreated={changed} onDeviceAdded={() => { void reload(); }} />
            </Card>
          </>
        ) : open?.id === "queue" ? (
          <PendingPostsCard
            posts={attention.posts}
            approvalOn={settings?.requireServiceApproval ?? true}
            busy={busy}
            onApprove={(postId) => act((tid) => boardsService.approve(tid, postId), "Approved: the service is on the board", "Could not approve")}
            onReject={(postId, reason) => act((tid) => boardsService.reject(tid, postId, reason), "Not approved", "Could not reject")}
          />
        ) : open?.id === "settings" ? (
          <>
            {hasPerm("manage_settings") && <BoardSettingsCard />}
            {data.board.canEdit && (
              <Card title="Controller board">
                <p className="card-description">
                  The public page of this tailnet: its purpose, how to join, contact details. Anyone on the internet can read it.
                </p>
                <ControllerBoardEditor key={data.board.text} initial={data.board.text} address={data.board.address} onSaved={() => { void reload(); }} />
              </Card>
            )}
          </>
        ) : (
          <>
            <Card
              title="Public board"
              actions={boardOn && <button type="button" className="btn-sm" onClick={() => setTab("board", "mine")}>Offer a service</button>}
            >
              <p className="card-description">
                Services that members offer to this tailnet. Connect the devices you choose; each one then reaches that
                service&apos;s one port.
                {data.mode.mode === "open" && " Members who chose the open policy already reach each other's devices."}
              </p>
              {!boardOn ? (
                <EmptyState>The public board is off in this tailnet.</EmptyState>
              ) : data.publicBoard.posts.length === 0 ? (
                <EmptyState>No services are offered yet.</EmptyState>
              ) : (
                <ul className="post-list">
                  {data.publicBoard.posts.map((p) => (
                    <PublicPostCard key={`${p.id}:${p.myConnectedDevices.join(",")}`} post={p} devices={data.devices.devices} onChanged={() => { void reload(); }} />
                  ))}
                </ul>
              )}
            </Card>

            {data.children.tailnets.length > 0 && (
              <Card title="Services in sub-collectives">
                <p className="card-description">
                  Public services of the tailnets below this one. This list is to read only: to use a service, join that tailnet.
                </p>
                {data.children.tailnets.map((c) => (
                  <section key={c.name + (c.address ?? "")} className="item-group">
                    <h4 className="group-heading">{c.name}</h4>
                    <ul className="post-list">
                      {c.posts.map((p) => (
                        <li key={p.id} className="post-card">
                          <div className="post-head">
                            <h4>{p.title}</h4>
                            <span className="mono text-sm">{p.proto} {p.port}</span>
                          </div>
                          {p.description && <p className="post-desc">{p.description}</p>}
                          <p className="text-dim text-sm">by @{p.author.handle}{p.web ? " · web application" : ""}</p>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </Card>
            )}
          </>
        )}
      </div>
    </>
  );
}
