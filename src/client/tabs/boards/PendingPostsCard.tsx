import { useState } from "react";
import { Card } from "../../components/Card";
import { Badge } from "../../components/Badge";
import { EmptyState } from "../../components/EmptyState";
import { InlinePrompt } from "../../components/InlinePrompt";
import type { PendingPost } from "../../services/boards";

export function PendingPostsCard({
  posts,
  onApprove,
  onReject,
  approvalOn,
  busy = false,
}: {
  posts: PendingPost[];
  approvalOn: boolean;
  busy?: boolean;
  onApprove: (postId: string) => void;
  onReject: (postId: string, reason: string) => void;
}) {
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  return (
    <Card title="Approval queue">
      <p className="card-description">
        {approvalOn
          ? "Public services that members want to offer. A service shows on the board only after you approve it."
          : "Approval is off, so new services show immediately. These services came in before and still wait for an answer."}
      </p>
      {posts.length === 0 && <EmptyState>No services wait for approval.</EmptyState>}
      <ul className="post-list">
        {posts.map((p) => (
          <li key={p.id} className="post-card">
            <div className="post-head">
              <h4>{p.title}</h4>
              <span className="mono text-sm">{p.proto} {p.port}</span>
              <Badge variant="pending">pending</Badge>
            </div>
            {p.description && <p className="post-desc">{p.description}</p>}
            <p className="text-dim text-sm">
              by @{p.authorHandle}
              {p.name ? ` · name ${p.name}` : ""}
              {p.web ? " · web application" : ""}
            </p>
            <div className="btn-group">
              <button type="button" className="btn-sm" disabled={busy} onClick={() => onApprove(p.id)}>
                Approve
              </button>
              <button
                type="button"
                className="btn-sm btn-danger"
                disabled={busy}
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
