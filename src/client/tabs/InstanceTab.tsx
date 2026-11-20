import { useCallback, useEffect, useState } from "react";
import { useApp } from "../hooks/useAppState";
import { useToast } from "../components/Toast";
import { Card } from "../components/Card";
import { Badge, StatusBadge } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { Loading } from "../components/Loading";
import { useConfirm } from "../components/ConfirmDialog";
import { Toggle } from "../components/Toggle";
import { ConnectClaude } from "../components/ConnectClaude";
import { operatorService } from "../services/operator";
import { instanceService } from "../services/instance";
import { ApiError } from "../services/api";
import { errorMessage, relativeTime } from "../lib/utils";
import type { InstanceInfo, OperatorAuditEntry, OperatorOverview, OperatorTenant, OperatorUser, TailnetCreator } from "../lib/types";

function conflictNames(e: unknown): string[] {
  if (!(e instanceof ApiError) || !e.body) return [];
  const list = Object.values(e.body).find(Array.isArray) as unknown[] | undefined;
  return (list ?? [])
    .map((x) => {
      if (typeof x === "string") return x;
      if (x && typeof x === "object") {
        const o = x as Record<string, unknown>;
        return String(o.name ?? o.slug ?? o.id ?? "");
      }
      return "";
    })
    .filter(Boolean);
}

export function InstanceTab() {
  const { user, tenants: myTenants, reload: reloadApp } = useApp();
  const { toast, toastError } = useToast();
  const [overview, setOverview] = useState<OperatorOverview | null>(null);
  const [creators, setCreators] = useState<TailnetCreator[]>([]);
  const [instance, setInstance] = useState<InstanceInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<OperatorTenant | null>(null);
  const [deleteText, setDeleteText] = useState("");
  const [conflict, setConflict] = useState<string[] | null>(null);
  const [creatorInput, setCreatorInput] = useState("");
  const confirm = useConfirm();

  const load = useCallback(async () => {
    try {
      const [o, c, i] = await Promise.all([
        operatorService.overview(),
        operatorService.getCreators(),
        instanceService.get().catch(() => null),
      ]);
      setOverview(o);
      setCreators(c);
      setInstance(i);
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e, "Failed to load instance overview"));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => Promise<unknown>, success: string, opts?: { reloadApp?: boolean }) => {
    if (busy) return false;
    setBusy(true);
    try {
      await fn();
      toast(success);
      await load();
      if (opts?.reloadApp) await reloadApp();
      return true;
    } catch (e) {
      toastError(errorMessage(e, "Operation failed"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const isMine = (tenantId: string) => myTenants.some((t) => t.id === tenantId);

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

  const toggleUser = async (u: OperatorUser) => {
    if (!u.disabled) {
      const n = u.tenantCount;
      const msg =
        `They won't be able to sign in, and their tokens and connected apps stop working. ` +
        `This also removes them from ${n === 1 ? "their tailnet" : `all ${n} of their tailnets`} ` +
        `and deletes their devices. Re-enabling them later does not restore memberships or devices.`;
      if (!(await confirm({ title: `Disable @${u.handle}?`, message: msg, confirmLabel: "Disable user", danger: true }))) return;
    }
    void run(
      () => operatorService.setUserDisabled(u.id, !u.disabled),
      u.disabled ? `@${u.handle} enabled` : `@${u.handle} disabled`,
    );
  };

  const setSingleTailnet = async (value: boolean) => {
    if (busy) return;
    setBusy(true);
    setConflict(null);
    try {
      await operatorService.updateSettings({ singleTailnet: value });
      toast(value ? "Single-tailnet mode on" : "Single-tailnet mode off");
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const names = conflictNames(e);
        setConflict(
          names.length > 0
            ? names
            : (overview?.tenants ?? []).filter((t) => !t.parentId && t.status !== "deleted").map((t) => t.name),
        );
      } else {
        toastError(errorMessage(e, "Failed to update settings"));
      }
    } finally {
      setBusy(false);
    }
  };

  const setDefault = (id: string) =>
    void run(
      () => operatorService.updateSettings({ defaultTailnetId: id || null }),
      id ? "Default tailnet updated" : "Default tailnet cleared",
    );

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

  if (loadError && !overview) {
    return (
      <div className="tab-content">
        <Card title="Instance">
          <p className="form-error" role="alert">{loadError}</p>
          <button type="button" className="btn-sm mt-8" onClick={() => { void load(); }}>Retry</button>
        </Card>
      </div>
    );
  }

  if (!overview) return <Loading />;

  const tenantName = (id: string | null) => overview.tenants.find((t) => t.id === id)?.name;
  const topLevel = overview.tenants.filter((t) => !t.parentId && t.status !== "deleted");
  const settings = overview.settings;

  return (
    <div className="tab-content">
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

      <Card title="Users">
        {overview.users.length === 0 ? (
          <EmptyState>No users yet.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="data-table stack">
              <caption className="sr-only">All users who have signed in to this instance</caption>
              <thead>
                <tr>
                  <th scope="col">Handle</th>
                  <th scope="col">DID</th>
                  <th scope="col">Tailnets</th>
                  <th scope="col"><span className="sr-only">Badges</span></th>
                  <th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {overview.users.map((u) => (
                  <tr key={u.id}>
                    <td data-label="Handle">@{u.handle}</td>
                    <td data-label="DID" className="mono text-xs">{u.did}</td>
                    <td data-label="Tailnets">{u.tenantCount}</td>
                    <td className="cell-badges">
                      <span className="badge-stack">
                        {u.isOperator && <Badge variant="originator">operator</Badge>}
                        {u.disabled && <Badge variant="stopped">disabled</Badge>}
                        {u.id === user?.id && <Badge variant="role">you</Badge>}
                      </span>
                    </td>
                    <td className="cell-actions">
                      {!u.isOperator && u.id !== user?.id && (
                        <button
                          type="button"
                          className={`btn-sm ${u.disabled ? "" : "btn-danger"}`}
                          disabled={busy}
                          onClick={() => { void toggleUser(u); }}
                          aria-label={`${u.disabled ? "Enable" : "Disable"} @${u.handle}`}
                        >
                          {u.disabled ? "Enable" : "Disable"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Instance settings">
        <div className="toggle-group">
          <Toggle
            label="Single-tailnet mode"
            description="The instance holds at most one top-level tailnet. Nobody, including tailnet creators, can create another tailnet or a sub-collective while this is on."
            checked={settings.singleTailnet}
            disabled={busy}
            onChange={(v) => { void setSingleTailnet(v); }}
          />
        </div>
        {conflict && (
          <div className="inline-alert" role="alert">
            <p>
              Single-tailnet mode can&apos;t be turned on while this instance has more than one top-level
              tailnet. Delete all but one of these first:
            </p>
            <ul>
              {conflict.map((n) => <li key={n}>{n}</li>)}
            </ul>
          </div>
        )}
        <div className="form-section">
          <h4><label htmlFor="default-tailnet">Default tailnet</label></h4>
          <p className="help-text" id="default-tailnet-help">
            Signed-in people without a tailnet are offered a &ldquo;Request to join&rdquo; button for the
            default tailnet. Join requests are enabled on it; its admins approve them in the Security tab.
          </p>
          <select
            id="default-tailnet"
            aria-describedby="default-tailnet-help"
            value={settings.defaultTailnetId ?? ""}
            disabled={busy}
            onChange={(e) => setDefault(e.target.value)}
          >
            <option value="">None (invite-only)</option>
            {topLevel.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          {instance?.defaultTailnet && !instance.defaultTailnet.acceptsJoinRequests && (
            <p className="help-text mt-8" role="status">
              {instance.defaultTailnet.name} currently isn&apos;t accepting join requests (it may be in
              lockdown or have join requests turned off), so visitors will see the invite-only message.
            </p>
          )}
        </div>
      </Card>

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

      <InstanceActivity />

      <ConnectClaude />
    </div>
  );
}

const ACTIVITY_PAGE = 25;

/** Instance-level audit trail: operator actions, user disable/enable, MCP grants. */
function InstanceActivity() {
  const [entries, setEntries] = useState<OperatorAuditEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadPage = useCallback(async (offset: number) => {
    setLoading(true);
    try {
      const page = await operatorService.audit(ACTIVITY_PAGE, offset);
      const got = page?.entries ?? [];
      setEntries((prev) => (offset === 0 ? got : [...prev, ...got]));
      setHasMore(page?.hasMore ?? false);
      setError(null);
    } catch (e) {
      setError(errorMessage(e, "Failed to load activity"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadPage(0); }, [loadPage]);

  return (
    <Card title="Activity">
      <p className="help-text">
        Instance-level events: operator actions, disabled users, MCP connections.
      </p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {entries.length === 0 && !error ? (
        loading ? <Loading /> : <EmptyState>No activity yet.</EmptyState>
      ) : (
        <ul className="item-list">
          {entries.map((e) => (
            <li key={e.id} className="item-row">
              <div className="item-info">
                <span className="item-name">{e.action.replace(/_/g, " ")}</span>
                <span className="item-detail">
                  {e.actorHandle ? `@${e.actorHandle}` : e.actorUserId}
                  {e.tenantSlug && <> · <span className="mono">{e.tenantSlug}</span></>}
                  {e.targetType && <> · {e.targetType}</>}
                  {" · "}{relativeTime(e.createdAt)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {hasMore && (
        <button type="button" className="btn-ghost mt-12" disabled={loading} onClick={() => void loadPage(entries.length)}>
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
    </Card>
  );
}
