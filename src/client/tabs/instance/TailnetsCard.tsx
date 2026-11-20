import { useState } from "react";
import { Card } from "../../components/Card";
import { Badge, StatusBadge } from "../../components/Badge";
import { EmptyState } from "../../components/EmptyState";
import { useConfirm } from "../../components/ConfirmDialog";
import { operatorService } from "../../services/operator";
import type { OperatorOverview, OperatorTenant } from "../../lib/types";
import type { RunAction } from "./types";

export function TailnetsCard({
  overview,
  busy,
  run,
  isMine,
}: {
  overview: OperatorOverview;
  busy: boolean;
  run: RunAction;
  isMine: (tenantId: string) => boolean;
}) {
  const [deleteTarget, setDeleteTarget] = useState<OperatorTenant | null>(null);
  const [deleteText, setDeleteText] = useState("");
  const confirm = useConfirm();
  const settings = overview.settings;
  const tenantName = (id: string | null) => overview.tenants.find((t) => t.id === id)?.name;

  const toggleSuspend = async (t: OperatorTenant) => {
    if (
      !t.suspended &&
      !(await confirm({
        title: `Suspend ${t.name}?`,
        message: "Its members lose dashboard access and its devices can't connect until you unsuspend it.",
        confirmLabel: "Suspend",
        danger: true,
      }))
    ) return;
    void run(
      () => operatorService.setSuspended(t.id, !t.suspended),
      t.suspended ? `${t.name} unsuspended` : `${t.name} suspended`,
      { reloadApp: isMine(t.id) },
    );
  };

  const confirmDelete = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = deleteTarget;
    if (!t || deleteText !== t.slug) return;
    const ok = await run(() => operatorService.deleteTenant(t.id), `${t.name} deleted`, { reloadApp: isMine(t.id) });
    if (ok) {
      setDeleteTarget(null);
      setDeleteText("");
    }
  };

  return (
    <Card title="Tailnets">
      {overview.tenants.length === 0 ? (
        <EmptyState>No tailnets on this instance yet.</EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="data-table stack">
            <caption className="sr-only">All tailnets on this instance</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Owner</th>
                <th scope="col">Members</th>
                <th scope="col">Devices</th>
                <th scope="col">Status</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {overview.tenants.map((t) => (
                <tr key={t.id}>
                  <td data-label="Name">
                    <div>
                    <div>{t.name}</div>
                    <div className="text-dim text-xs mono">{t.slug}</div>
                    {t.parentId && (
                      <div className="text-dim text-xs">sub-collective of {tenantName(t.parentId) ?? "another tailnet"}</div>
                    )}
                    </div>
                  </td>
                  <td data-label="Owner">{t.owner ? `@${t.owner.handle}` : <span className="text-dim">none</span>}</td>
                  <td data-label="Members">{t.memberCount}</td>
                  <td data-label="Devices">{t.deviceCount ?? <span className="text-dim" title="Device count unavailable">&mdash;</span>}</td>
                  <td data-label="Status">
                    <span className="badge-stack">
                      <StatusBadge status={t.status} />
                      {t.suspended && <Badge variant="stopped">suspended</Badge>}
                      {settings.defaultTailnetId === t.id && <Badge variant="originator">default</Badge>}
                    </span>
                  </td>
                  <td className="cell-actions">
                    {t.status !== "deleted" && (
                      <div className="btn-group">
                        <button
                          type="button"
                          className={`btn-sm ${t.suspended ? "" : "btn-ghost"}`}
                          disabled={busy}
                          onClick={() => { void toggleSuspend(t); }}
                          aria-label={`${t.suspended ? "Unsuspend" : "Suspend"} ${t.name}`}
                        >
                          {t.suspended ? "Unsuspend" : "Suspend"}
                        </button>
                        <button
                          type="button"
                          className="btn-sm btn-danger"
                          disabled={busy}
                          onClick={() => { setDeleteTarget(t); setDeleteText(""); }}
                          aria-label={`Delete ${t.name}`}
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {deleteTarget && (
        <form className="confirm-panel" onSubmit={confirmDelete} aria-labelledby="delete-tenant-heading">
          <h4 id="delete-tenant-heading">Delete {deleteTarget.name}?</h4>
          <p className="help-text">
            This permanently deletes the tailnet, removes all of its members, and deletes its devices.
            It cannot be undone. Type <strong className="mono">{deleteTarget.slug}</strong> to confirm.
          </p>
          <div className="inline-form">
            <input
              type="text"
              className="mono"
              spellCheck={false}
              value={deleteText}
              onChange={(e) => setDeleteText(e.target.value)}
              aria-label={`Type ${deleteTarget.slug} to confirm deletion`}
              autoComplete="off"
              autoFocus
            />
            <button type="submit" className="btn-danger" disabled={busy || deleteText !== deleteTarget.slug}>
              Delete tailnet
            </button>
            <button type="button" className="btn-ghost" onClick={() => setDeleteTarget(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </Card>
  );
}
