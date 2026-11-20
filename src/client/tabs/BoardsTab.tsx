import { useCallback, useEffect, useState } from "react";
import { useApp } from "../hooks/useAppState";
import { useToast } from "../components/Toast";
import { useConfirm } from "../components/ConfirmDialog";
import { Card } from "../components/Card";
import { Badge } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { InlinePrompt } from "../components/InlinePrompt";
import { BoardText } from "../components/BoardText";
import { errorMessage } from "../lib/utils";
import { lintBoardText, BOARD_TEXT_MAX_LENGTH } from "../../shared/board-text";
import {
  boardsService,
  type MyDevice,
  type MyPost,
  type NewPost,
  type PendingPost,
  type PublicPost,
} from "../services/boards";

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

/** Checkbox list of the caller's devices. */
function DevicePicker({
  devices,
  selected,
  onChange,
  idPrefix,
}: {
  devices: MyDevice[];
  selected: string[];
  onChange: (ids: string[]) => void;
  idPrefix: string;
}) {
  if (devices.length === 0) {
    return <p className="help-text">You have no devices in this tailnet yet. Add one in the Add device tab.</p>;
  }
  return (
    <fieldset className="device-picker">
      <legend className="text-sm">Your devices</legend>
      {devices.map((d) => (
        <label key={d.id} htmlFor={`${idPrefix}-${d.id}`} className="device-option">
          <input
            id={`${idPrefix}-${d.id}`}
            type="checkbox"
            checked={selected.includes(d.id)}
            onChange={(e) => onChange(e.target.checked ? [...selected, d.id] : selected.filter((x) => x !== d.id))}
          />
          <span>{d.name}</span>
          <span className="text-dim text-xs">{d.online ? "online" : "offline"}</span>
        </label>
      ))}
    </fieldset>
  );
}

function PublicPostCard({ post, devices, onChanged }: { post: PublicPost; devices: MyDevice[]; onChanged: () => void }) {
  const { currentTenant } = useApp();
  const { toast, toastError } = useToast();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>(post.myConnectedDevices);
  const [busy, setBusy] = useState(false);
  const connected = post.myConnectedDevices.length > 0;

  const save = async (ids: string[]) => {
    if (!currentTenant) return;
    setBusy(true);
    try {
      const r = await boardsService.setConnections(currentTenant.id, post.id, ids);
      toast(ids.length === 0 ? "Disconnected" : r?.applied === false ? "Saved; it will apply shortly" : "Connected");
      setOpen(false);
      onChanged();
    } catch (e) {
      toastError(errorMessage(e, "Could not change the connection"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="post-card">
      <div className="post-head">
        <h4>{post.title}</h4>
        <span className="mono text-sm">
          {post.proto} {post.port}
        </span>
        {connected && <Badge variant="running">connected</Badge>}
        {!post.deviceOnline && <Badge variant="stopped">offline</Badge>}
      </div>
      {post.description && <p className="post-desc">{post.description}</p>}
      <p className="text-dim text-sm">
        by @{post.author.handle}
        {post.isAuthor && post.connectedDevices !== undefined && ` · ${post.connectedDevices} device(s) connected`}
      </p>
      {post.url ? (
        <p className="post-address">
          <a className="mono" href={post.url} target="_blank" rel="noreferrer">{post.url}</a>
        </p>
      ) : (
        post.address && (
          <p className="post-address">
            Address: <span className="mono">{post.address}:{post.port}</span>
          </p>
        )
      )}
      {!post.isAuthor &&
        (open ? (
          <div className="form-stack">
            <DevicePicker devices={devices} selected={selected} onChange={setSelected} idPrefix={`post-${post.id}`} />
            <p className="help-text">
              The devices you select can reach this one port on the service device. Nothing else is opened.
            </p>
            <div className="btn-group">
              <button type="button" disabled={busy || selected.length === 0} onClick={() => { void save(selected); }}>
                {busy ? "Saving..." : "Connect selected devices"}
              </button>
              {connected && (
                <button type="button" className="btn-danger" disabled={busy} onClick={() => { void save([]); }}>
                  Disconnect all
                </button>
              )}
              <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn-sm" onClick={() => setOpen(true)}>{connected ? "Change devices" : "Connect"}</button>
        ))}
    </li>
  );
}

const EMPTY_POST: NewPost = { board: "private", title: "", description: "", nodeId: "", port: 0, proto: "tcp", name: "", web: false };

function NewServiceForm({
  devices,
  baseDomain,
  httpsServices,
  onCreated,
}: {
  devices: MyDevice[];
  baseDomain: string;
  httpsServices: boolean;
  onCreated: () => void;
}) {
  const { currentTenant } = useApp();
  const { toast, toastError } = useToast();
  const [post, setPost] = useState<NewPost>({ ...EMPTY_POST, nodeId: devices[0]?.id ?? "" });
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<NewPost>) => setPost((p) => ({ ...p, ...patch }));
  const valid = post.title.trim() && post.nodeId && post.port >= 1 && post.port <= 65535 && (post.board === "public" || post.name?.trim());

  const submit = async () => {
    if (!currentTenant || !valid) return;
    setBusy(true);
    try {
      const created = await boardsService.create(currentTenant.id, {
        ...post,
        title: post.title.trim(),
        description: post.description?.trim() || undefined,
        name: post.name?.trim().toLowerCase() || undefined,
        web: Boolean(post.web && post.proto === "tcp" && post.name),
      });
      toast(created?.status === "pending" ? "Sent for approval" : "Service added");
      setPost({ ...EMPTY_POST, nodeId: devices[0]?.id ?? "" });
      onCreated();
    } catch (e) {
      toastError(errorMessage(e, "Could not add the service"));
    } finally {
      setBusy(false);
    }
  };

  if (devices.length === 0) {
    return <p className="help-text">Add a device first (Add device tab). A service runs on one of your devices.</p>;
  }

  return (
    <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <label htmlFor="svc-board">Board</label>
      <select id="svc-board" value={post.board} onChange={(e) => set({ board: e.target.value as NewPost["board"] })}>
        <option value="private">Private — only my devices</option>
        <option value="public">Public — offer to members (needs approval)</option>
      </select>

      <label htmlFor="svc-title">Title</label>
      <input id="svc-title" type="text" maxLength={120} value={post.title} onChange={(e) => set({ title: e.target.value })} required />

      <label htmlFor="svc-desc">Description</label>
      <textarea id="svc-desc" maxLength={1000} value={post.description} onChange={(e) => set({ description: e.target.value })} />

      <label htmlFor="svc-device">Device</label>
      <select id="svc-device" value={post.nodeId} onChange={(e) => set({ nodeId: e.target.value })}>
        {devices.map((d) => (
          <option key={d.id} value={d.id}>{d.name}</option>
        ))}
      </select>

      <label htmlFor="svc-port">Port</label>
      <div className="inline-form">
        <select aria-label="Protocol" value={post.proto} onChange={(e) => set({ proto: e.target.value as NewPost["proto"] })}>
          <option value="tcp">TCP</option>
          <option value="udp">UDP</option>
        </select>
        <input
          id="svc-port"
          type="number"
          min={1}
          max={65535}
          value={post.port || ""}
          onChange={(e) => set({ port: Number(e.target.value) })}
          required
        />
      </div>

      <label htmlFor="svc-name">Name{post.board === "public" ? " (optional)" : ""}</label>
      <div>
        <div className="inline-form">
          <input
            id="svc-name"
            type="text"
            maxLength={63}
            value={post.name}
            spellCheck={false}
            onChange={(e) => set({ name: e.target.value.trim().toLowerCase() })}
          />
          <span className="mono text-dim">.{baseDomain}</span>
        </div>
        <p className="help-text">
          {post.board === "private"
            ? "The private address of this service on your own devices."
            : "Only this one port is offered. Other ports on the device stay private."}
        </p>
      </div>

      {httpsServices && (
        <>
          <span />
          <div>
            <label className="check-row">
              <input
                type="checkbox"
                checked={Boolean(post.web)}
                disabled={post.proto !== "tcp" || !post.name}
                onChange={(e) => set({ web: e.target.checked })}
              />
              <span>This is a web application: give it a secure web address</span>
            </label>
            <p className="help-text">
              {post.web && post.name
                ? <>It opens at <span className="mono">https://{post.name}.{baseDomain}</span> inside the tailnet, with a valid certificate. The application gets the name and the device of each visitor in the headers <span className="mono">X-Tailnet-User</span> and <span className="mono">X-Tailnet-Device</span>. It must listen on the tailnet address of the device, not only on localhost.</>
                : "Needs a name and TCP. Without this, the name points at the device and you add the port yourself."}
            </p>
          </div>
        </>
      )}

      <div className="form-actions">
        <button type="submit" disabled={busy || !valid}>{busy ? "Adding..." : "Add service"}</button>
      </div>
    </form>
  );
}

function ControllerBoardEditor({ initial, address, onSaved }: { initial: string; address: string; onSaved: () => void }) {
  const { currentTenant } = useApp();
  const { toast, toastError } = useToast();
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const problems = lintBoardText(text);

  const save = async () => {
    if (!currentTenant || problems.length > 0) return;
    setBusy(true);
    try {
      await boardsService.setControllerBoard(currentTenant.id, text);
      toast("Controller board saved");
      onSaved();
    } catch (e) {
      toastError(errorMessage(e, "Could not save the controller board"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="editor-split">
      <div className="form-stack">
        <label htmlFor="controller-text" className="text-sm">
          Text (headings with #, lists with -, **bold**, *italic*, [link](https://…))
        </label>
        <textarea
          id="controller-text"
          className="controller-input"
          value={text}
          maxLength={BOARD_TEXT_MAX_LENGTH}
          onChange={(e) => setText(e.target.value)}
          aria-describedby="controller-help"
        />
        <p id="controller-help" className="help-text" role={problems.length ? "alert" : undefined}>
          {problems[0] ?? `${text.length} / ${BOARD_TEXT_MAX_LENGTH} characters. Text only: HTML is shown as written.`}
        </p>
        <div className="btn-group">
          <button type="button" disabled={busy || problems.length > 0 || text === initial} onClick={() => { void save(); }}>
            {busy ? "Saving..." : "Save"}
          </button>
          <a className="btn-sm btn-ghost" href={`/board/${address}`} target="_blank" rel="noopener noreferrer">
            Open public page
          </a>
        </div>
      </div>
      <div className="preview-pane" aria-label="Preview">
        <p className="text-dim text-xs">Preview — what anyone on the internet sees</p>
        {text.trim() ? <BoardText text={text} /> : <p className="text-dim">Nothing yet.</p>}
      </div>
    </div>
  );
}

export function BoardsTab() {
  const { currentTenant, hasPerm } = useApp();
  const { toast, toastError } = useToast();
  const confirm = useConfirm();
  const [state, setState] = useState<State | null>(null);
  const [failed, setFailed] = useState(false);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
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
      toastError(errorMessage(e, fail));
    }
  };
  const mine = (board: "public" | "private") => state.myPosts.filter((p) => p.board === board);

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
        <Card title="Waiting for approval">
          <ul className="post-list">
            {state.pending.map((p) => (
              <li key={p.id} className="post-card">
                <div className="post-head">
                  <h4>{p.title}</h4>
                  <span className="mono text-sm">{p.proto} {p.port}</span>
                  <Badge variant="pending">pending</Badge>
                </div>
                {p.description && <p className="post-desc">{p.description}</p>}
                <p className="text-dim text-sm">by @{p.authorHandle}</p>
                <div className="btn-group">
                  <button type="button" className="btn-sm" onClick={() => { void act(() => boardsService.approve(tid, p.id), "Approved", "Could not approve"); }}>
                    Approve
                  </button>
                  <button
                    type="button"
                    className="btn-sm btn-danger"
                    aria-expanded={rejectingId === p.id}
                    onClick={() => setRejectingId(rejectingId === p.id ? null : p.id)}
                  >
                    Reject
                  </button>
                </div>
                {rejectingId === p.id && (
                  <InlinePrompt
                    label="Reason (shown to the author, optional)"
                    submitLabel="Reject post"
                    danger
                    onCancel={() => setRejectingId(null)}
                    onSubmit={(reason) => {
                      setRejectingId(null);
                      void act(() => boardsService.reject(tid, p.id, reason), "Not approved", "Could not reject");
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="My private board">
        <p className="card-description">Services you run for your own devices. Only you see this list.</p>
        {mine("private").length === 0 ? (
          <EmptyState>No private services yet.</EmptyState>
        ) : (
          <ul className="post-list">
            {mine("private").map((p) => (
              <li key={p.id} className="post-card">
                <div className="post-head">
                  <h4>{p.title}</h4>
                  <span className="mono text-sm">{p.proto} {p.port}</span>
                </div>
                <p className="post-address">
                  {p.web ? (
                    <a className="mono" href={`https://${p.name}.${state.baseDomain}`} target="_blank" rel="noreferrer">https://{p.name}.{state.baseDomain}</a>
                  ) : (
                    <span className="mono">{p.name}.{state.baseDomain}</span>
                  )}
                  {p.device?.address && <span className="text-dim"> · {p.device.address}:{p.port} on {p.device.name}</span>}
                </p>
                <button type="button" className="btn-sm btn-ghost" onClick={() => { void act(() => boardsService.remove(tid, p.id), "Removed", "Could not remove"); }}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="My services on the public board">
        {mine("public").length === 0 ? (
          <EmptyState>You offer no services to the tailnet.</EmptyState>
        ) : (
          <ul className="post-list">
            {mine("public").map((p) => (
              <li key={p.id} className="post-card">
                <div className="post-head">
                  <h4>{p.title}</h4>
                  <span className="mono text-sm">{p.proto} {p.port}</span>
                  <Badge variant={p.status === "approved" ? "running" : p.status === "pending" ? "pending" : "stopped"}>{p.status}</Badge>
                </div>
                {p.status === "rejected" && p.rejectReason && <p className="help-text">Reason: {p.rejectReason}</p>}
                <p className="text-dim text-sm">on {p.device?.name ?? "a device that is gone"}</p>
                {p.connections && p.connections.length > 0 && (
                  <ul className="item-list">
                    {p.connections.map((c) => (
                      <li key={c.userId} className="item-row">
                        <span>@{c.handle} · {c.devices} device(s)</span>
                        <button type="button"
                          className="btn-sm btn-ghost"
                          onClick={() => { void act(() => boardsService.disconnectMember(tid, p.id, c.userId), "Disconnected", "Could not disconnect"); }}
                        >
                          Disconnect
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <button type="button" className="btn-sm btn-ghost" onClick={() => { void act(() => boardsService.remove(tid, p.id), "Removed", "Could not remove"); }}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

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
        <Card title="Device access">
          <p className="card-description">
            {state.mode === "member"
              ? "Members only: a device reaches its owner's other devices, plus services they connected to and shares between friends."
              : "Open: every device in this tailnet can reach every other device on every port."}
          </p>
          <button
            type="button"
            className="btn-sm"
            onClick={async () => {
              const next = state.mode === "member" ? "open" : "member";
              if (next === "member" && !(await confirm({
                title: "Switch to members-only access?",
                message: "Devices of different members will stop reaching each other until they connect to a service or share.",
                confirmLabel: "Switch",
              }))) return;
              void act(() => boardsService.setAccessMode(tid, next), "Access mode changed", "Could not change the access mode");
            }}
          >
            {state.mode === "member" ? "Switch to open" : "Switch to members only"}
          </button>
        </Card>
      )}
    </div>
  );
}
