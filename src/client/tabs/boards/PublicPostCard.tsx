import { useState } from "react";
import { useTenantMutation } from "../../hooks/useMutation";
import { useToast } from "../../components/Toast";
import { Badge } from "../../components/Badge";
import { boardsService, type MyDevice, type PublicPost } from "../../services/boards";

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

export function PublicPostCard({ post, devices, onChanged }: { post: PublicPost; devices: MyDevice[]; onChanged: () => void }) {
  const { toast } = useToast();
  const { mutate, busy } = useTenantMutation({ onError: "Could not change the connection" });
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>(post.myConnectedDevices);
  const connected = post.myConnectedDevices.length > 0;

  const save = (ids: string[]) =>
    mutate(async (tid) => {
      const r = await boardsService.setConnections(tid, post.id, ids);
      toast(ids.length === 0 ? "Disconnected" : r?.applied === false ? "Saved; it will apply shortly" : "Connected");
      setOpen(false);
      onChanged();
    });

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
