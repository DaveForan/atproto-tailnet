import { useState } from "react";
import { Card } from "../../components/Card";
import { Badge } from "../../components/Badge";
import { EmptyState } from "../../components/EmptyState";
import { useConfirm } from "../../components/ConfirmDialog";
import { operatorService } from "../../services/operator";
import { relativeTime } from "../../lib/utils";
import type { TailnetCreator } from "../../lib/types";
import type { RunAction } from "./types";

export function CreatorsCard({ creators, busy, run }: { creators: TailnetCreator[]; busy: boolean; run: RunAction }) {
  const [creatorInput, setCreatorInput] = useState("");
  const confirm = useConfirm();

  const addCreator = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!creatorInput.trim()) return;
    const ok = await run(() => operatorService.addCreator(creatorInput), "Tailnet creator added");
    if (ok) setCreatorInput("");
  };

  const removeCreator = async (c: TailnetCreator) => {
    const name = c.handle ? `@${c.handle}` : c.did;
    if (!(await confirm({
      title: `Remove ${name} as a tailnet creator?`,
      message: `${c.hasTailnet ? "Their existing tailnet is not deleted; they" : "They"} won't be able to create a new tailnet.`,
      confirmLabel: "Remove",
      danger: true,
    }))) return;
    void run(() => operatorService.removeCreator(c.id), `${name} removed`);
  };

  return (
    <Card title="Tailnet creators">
      <p className="help-text">
        Operators can always have a tailnet. Add other people here to let them have their own. Removing
        someone doesn&apos;t delete a tailnet they already have.
      </p>
      <form className="field" onSubmit={addCreator}>
        <label htmlFor="creator-input">Handle or DID</label>
        <div className="inline-form">
          <input
            id="creator-input"
            type="text"
            placeholder="handle.bsky.social or did:plc:..."
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={creatorInput}
            onChange={(e) => setCreatorInput(e.target.value)}
          />
          <button type="submit" disabled={busy || !creatorInput.trim()}>Add creator</button>
        </div>
      </form>
      {creators.length === 0 ? (
        <EmptyState>No tailnet creators designated.</EmptyState>
      ) : (
        <ul className="item-list mt-12">
          {creators.map((c) => (
            <li key={c.id} className="item-row">
              <div className="item-info">
                <span className="item-name">{c.handle ? `@${c.handle}` : c.did}</span>
                <span className="item-detail">
                  {c.handle && <span className="mono">{c.did} · </span>}
                  added {relativeTime(c.createdAt)}
                </span>
              </div>
              <div className="item-actions">
                <Badge variant={c.hasTailnet ? "running" : "role"}>
                  {c.hasTailnet ? "has tailnet" : "no tailnet yet"}
                </Badge>
                <button
                  type="button"
                  className="btn-sm btn-danger"
                  disabled={busy}
                  onClick={() => { void removeCreator(c); }}
                  aria-label={`Remove ${c.handle ? `@${c.handle}` : c.did} as tailnet creator`}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
