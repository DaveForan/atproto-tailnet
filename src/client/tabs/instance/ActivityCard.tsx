import { useCallback, useEffect, useState } from "react";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { Loading } from "../../components/Loading";
import { operatorService } from "../../services/operator";
import { errorMessage, relativeTime } from "../../lib/utils";
import type { OperatorAuditEntry } from "../../lib/types";

const ACTIVITY_PAGE = 25;

/** Instance-level audit trail: operator actions, user disable/enable, MCP grants. */
export function InstanceActivity() {
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
