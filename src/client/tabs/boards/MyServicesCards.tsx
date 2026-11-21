import { Card } from "../../components/Card";
import { Badge } from "../../components/Badge";
import { EmptyState } from "../../components/EmptyState";
import type { MyPost } from "../../services/boards";

export function PrivateBoardCard({
  posts,
  baseDomain,
  serviceDomain,
  onRemove,
  busy = false,
}: {
  posts: MyPost[];
  baseDomain: string;
  serviceDomain: string | null;
  onRemove: (postId: string) => void;
  busy?: boolean;
}) {
  return (
    <Card title="My private board">
      <p className="card-description">Services you run for your own devices. Only you see this list.</p>
      {posts.length === 0 ? (
        <EmptyState>No private services yet.</EmptyState>
      ) : (
        <ul className="post-list">
          {posts.map((p) => (
            <li key={p.id} className="post-card">
              <div className="post-head">
                <h4>{p.title}</h4>
                <span className="mono text-sm">{p.proto} {p.port}</span>
              </div>
              <p className="post-address">
                {p.web && serviceDomain ? (
                  <a className="mono" href={`https://${p.name}.${serviceDomain}`} target="_blank" rel="noreferrer">https://{p.name}.{serviceDomain}</a>
                ) : (
                  <span className="mono">{p.name}.{baseDomain}</span>
                )}
                {p.device?.address && <span className="text-dim"> · {p.device.address}:{p.port} on {p.device.name}</span>}
              </p>
              <button type="button" className="btn-sm btn-ghost" disabled={busy} onClick={() => onRemove(p.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function MyPublicServicesCard({
  posts,
  onRemove,
  onDisconnect,
  busy = false,
}: {
  posts: MyPost[];
  onRemove: (postId: string) => void;
  onDisconnect: (postId: string, userId: string) => void;
  busy?: boolean;
}) {
  return (
    <Card title="My services on the public board">
      {posts.length === 0 ? (
        <EmptyState>You offer no services to the tailnet.</EmptyState>
      ) : (
        <ul className="post-list">
          {posts.map((p) => (
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
                        disabled={busy}
                        onClick={() => onDisconnect(p.id, c.userId)}
                      >
                        Disconnect
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <button type="button" className="btn-sm btn-ghost" disabled={busy} onClick={() => onRemove(p.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
