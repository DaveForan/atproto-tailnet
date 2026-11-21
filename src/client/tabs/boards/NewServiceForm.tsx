import { useCallback, useState } from "react";
import { useTenantMutation } from "../../hooks/useMutation";
import { useToast } from "../../components/Toast";
import { boardsService, type MyDevice, type NewPost } from "../../services/boards";
import { AddDeviceInline } from "./AddDeviceInline";
import { RolePicker } from "./RolePicker";

const EMPTY_POST: NewPost = { board: "private", title: "", description: "", nodeId: "", port: 0, proto: "tcp", name: "", web: false };

export function NewServiceForm({
  devices,
  baseDomain,
  serviceDomain,
  httpsServices,
  onCreated,
  onDeviceAdded,
}: {
  devices: MyDevice[];
  baseDomain: string;
  serviceDomain: string | null;
  httpsServices: boolean;
  onCreated: () => void;
  /** A device joined from inside this form: the caller reloads its device list. */
  onDeviceAdded: () => void;
}) {
  const { toast } = useToast();
  const { mutate, busy } = useTenantMutation({ onError: "Could not add the service" });
  const [post, setPost] = useState<NewPost>({ ...EMPTY_POST, nodeId: devices[0]?.id ?? "" });
  const set = (patch: Partial<NewPost>) => setPost((p) => ({ ...p, ...patch }));
  // The device that joined from this form, until the reloaded list contains it
  const [joined, setJoined] = useState<MyDevice | null>(null);
  const onJoined = useCallback(
    (device: MyDevice) => {
      setJoined(device);
      setPost((p) => ({ ...p, nodeId: device.id }));
      onDeviceAdded();
    },
    [onDeviceAdded],
  );
  const choices = joined && !devices.some((d) => d.id === joined.id) ? [...devices, joined] : devices;
  const domain = post.web && serviceDomain ? serviceDomain : baseDomain;
  const valid = post.title.trim() && post.nodeId && post.port >= 1 && post.port <= 65535 && (post.board === "public" || post.name?.trim());

  const submit = async () => {
    if (!valid) return;
    await mutate(async (tid) => {
      const created = await boardsService.create(tid, {
        ...post,
        title: post.title.trim(),
        description: post.description?.trim() || undefined,
        name: post.name?.trim().toLowerCase() || undefined,
        web: Boolean(post.web && post.proto === "tcp" && post.name),
        roleIds: post.board === "public" ? (post.roleIds ?? []) : undefined,
      });
      toast(created?.status === "pending" ? "Sent for approval" : "Service added");
      setPost({ ...EMPTY_POST, nodeId: devices[0]?.id ?? "" });
      onCreated();
    });
  };

  if (choices.length === 0) {
    return (
      <div>
        <p className="help-text">A service runs on one of your devices. You have none in this tailnet yet.</p>
        <AddDeviceInline known={devices} onJoined={onJoined} />
      </div>
    );
  }

  return (
    <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <label htmlFor="svc-board">Board</label>
      <select id="svc-board" value={post.board} onChange={(e) => set({ board: e.target.value as NewPost["board"] })}>
        <option value="private">Private — only my devices</option>
        <option value="public">Public — offer to members (needs approval)</option>
      </select>

      {post.board === "public" && (
        <>
          <span className="form-label">Who may connect</span>
          <RolePicker selected={post.roleIds ?? []} onChange={(roleIds) => set({ roleIds })} />
        </>
      )}

      <label htmlFor="svc-title">Title</label>
      <input id="svc-title" type="text" maxLength={120} value={post.title} onChange={(e) => set({ title: e.target.value })} required />

      <label htmlFor="svc-desc">Description</label>
      <textarea id="svc-desc" maxLength={1000} value={post.description} onChange={(e) => set({ description: e.target.value })} />

      <label htmlFor="svc-device">Device</label>
      <div>
        <select id="svc-device" value={post.nodeId} onChange={(e) => set({ nodeId: e.target.value })}>
          {choices.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
        <AddDeviceInline known={choices} onJoined={onJoined} />
      </div>

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
          <span className="mono text-dim">.{domain}</span>
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
                ? <>It opens at <span className="mono">https://{post.name}.{domain}</span> inside the tailnet, with a valid certificate. The application gets the name and the device of each visitor in the headers <span className="mono">X-Tailnet-User</span> and <span className="mono">X-Tailnet-Device</span>. It must listen on the tailnet address of the device, not only on localhost.</>
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
