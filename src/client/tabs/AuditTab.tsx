import { useCallback, useEffect, useState } from "react";
import { auditService } from "../services/audit";
import { useApp } from "../hooks/useAppState";
import { useToast } from "../components/Toast";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { Loading } from "../components/Loading";
import { auditActionLabels, relativeTime } from "../lib/utils";
import type { AuditEntry } from "../lib/types";

const PAGE_SIZE = 50;

export function AuditTab() {
  const { currentTenant } = useApp();
  const { toastError } = useToast();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const loadEntries = useCallback(async (currentOffset: number, append: boolean) => {
    if (!currentTenant) return;
    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
    }
    try {
      const data = await auditService.getAuditLog(currentTenant.id, PAGE_SIZE, currentOffset);
      const items = data?.entries ?? [];
      const total = data?.total ?? 0;
      if (append) {
        setEntries((prev) => [...prev, ...items]);
      } else {
        setEntries(items);
      }
      setHasMore(currentOffset + items.length < total);
    } catch (e) {
      toastError(
        e instanceof Error ? e.message : "Failed to load audit log",
      );
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [currentTenant?.id]);

  useEffect(() => {
    setOffset(0);
    loadEntries(0, false);
  }, [loadEntries]);

  const handleLoadMore = () => {
    const nextOffset = offset + PAGE_SIZE;
    setOffset(nextOffset);
    loadEntries(nextOffset, true);
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
                <button type="button" className="btn-ghost" onClick={handleLoadMore} disabled={loadingMore}>
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
