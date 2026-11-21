import { useState } from "react";
import { auditService } from "../services/audit";
import { useTenant } from "../hooks/session";
import { useTenantData } from "../hooks/useTenantData";
import { useToast } from "../components/Toast";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { Loading } from "../components/Loading";
import { LoadError } from "../components/LoadError";
import { auditActionLabels, relativeTime } from "../lib/utils";
import type { AuditEntry } from "../lib/types";

const PAGE_SIZE = 50;

interface AuditPage {
  entries: AuditEntry[];
  total: number;
}

export function AuditTab() {
  const { currentTenant } = useTenant();
  const { toastFailure } = useToast();
  const { data: first, loading, error, reload } = useTenantData<AuditPage>(
    (tid) => auditService.getAuditLog(tid, PAGE_SIZE, 0).then((d) => ({ entries: d?.entries ?? [], total: d?.total ?? 0 })),
    { entries: [], total: 0 },
  );
  // Later pages, appended to the first one; a reload of the first page drops them
  const [more, setMore] = useState<{ base: AuditPage; entries: AuditEntry[]; total: number } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const extra = more?.base === first ? more : null;
  const entries = extra ? [...first.entries, ...extra.entries] : first.entries;
  const total = extra ? extra.total : first.total;
  const hasMore = entries.length < total;

  const handleLoadMore = async () => {
    if (!currentTenant || loadingMore) return;
    setLoadingMore(true);
    try {
      const d = await auditService.getAuditLog(currentTenant.id, PAGE_SIZE, entries.length);
      setMore({ base: first, entries: [...(extra?.entries ?? []), ...(d?.entries ?? [])], total: d?.total ?? total });
    } catch (e) {
      toastFailure(e, "Failed to load audit log");
    } finally {
      setLoadingMore(false);
    }
  };

  const formatDetail = (detail?: Record<string, unknown> | null): string => {
    if (!detail) return "";
    const parts: string[] = [];
    for (const [key, value] of Object.entries(detail)) {
      parts.push(`${key}: ${String(value)}`);
    }
    return parts.join(", ");
  };

  if (loading) return <Loading />;

  return (
    <div className="tab-content">
      <LoadError error={error} onRetry={reload} />
      <Card title="Audit log">
        {entries.length === 0 ? (
          <EmptyState>No audit log entries.</EmptyState>
        ) : (
          <>
            <ul className="item-list">
              {entries.map((entry) => (
                <li key={entry.id} className="item-row">
                  <div className="item-info">
                    <div className="item-header">
                      <span className="item-name">
                        {auditActionLabels[entry.action] ?? entry.action}
                      </span>
                      <span className="item-meta">
                        {relativeTime(entry.createdAt)}
                      </span>
                    </div>
                    <div className="item-meta">
                      {entry.actorHandle && (
                        <span>
                          by {entry.actorDisplayName || entry.actorHandle}
                        </span>
                      )}
                      {entry.metadata && (
                        <span>{formatDetail(entry.metadata)}</span>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            {hasMore && (
              <div className="form-footer mt-12">
                <button type="button" className="btn-ghost" onClick={() => { void handleLoadMore(); }} disabled={loadingMore}>
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
