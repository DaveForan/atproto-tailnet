import { useState } from "react";
import { Card } from "../../components/Card";
import { Badge } from "../../components/Badge";
import { InlinePrompt } from "../../components/InlinePrompt";
import type { PendingPost } from "../../services/boards";

export function PendingPostsCard({
  posts,
  onApprove,
  onReject,
}: {
  posts: PendingPost[];
  onApprove: (postId: string) => void;
  onReject: (postId: string, reason: string) => void;
}) {
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  return (
    <Card title="Waiting for approval">
      <ul className="post-list">
        {posts.map((p) => (
          <li key={p.id} className="post-card">
            <div className="post-head">
              <h4>{p.title}</h4>
              <span className="mono text-sm">{p.proto} {p.port}</span>
              <Badge variant="pending">pending</Badge>
            </div>
            {p.description && <p className="post-desc">{p.description}</p>}
            <p className="text-dim text-sm">by @{p.authorHandle}</p>
            <div className="btn-group">
              <button type="button" className="btn-sm" onClick={() => onApprove(p.id)}>
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
                  onReject(p.id, reason);
                }}
              />
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
