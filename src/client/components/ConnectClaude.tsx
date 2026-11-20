import { useCallback, useEffect, useState } from "react";
import { mcpService } from "../services/mcp";
import { useApp } from "../hooks/useAppState";
import { useToast } from "./Toast";
import { Card } from "./Card";
import { CopyField } from "./CopyField";
import { EmptyState } from "./EmptyState";
import { Loading } from "./Loading";
import { Badge } from "./Badge";
import { useConfirm } from "./ConfirmDialog";
import { errorMessage, relativeTime } from "../lib/utils";
import type { McpConnection } from "../lib/types";

export function ConnectClaude() {
  const { user } = useApp();
  const { toast, toastError } = useToast();
  const [connections, setConnections] = useState<McpConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  const url = `${window.location.origin}/mcp`;

  const load = useCallback(async () => {
    try {
      setConnections(await mcpService.connections());
    } catch (e) {
      toastError(errorMessage(e, "Failed to load connected apps"));
    } finally {
      setLoading(false);
    }
  }, [toastError]);

  useEffect(() => { void load(); }, [load]);

  const revoke = async (c: McpConnection) => {
    if (!(await confirm({ title: `Disconnect ${c.clientName}?`, message: "It will lose access immediately.", confirmLabel: "Disconnect", danger: true }))) return;
    setBusy(true);
    try {
      await mcpService.revoke(c.id);
      toast(`${c.clientName} disconnected`);
      await load();
    } catch (e) {
      toastError(errorMessage(e, "Failed to revoke connection"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card title="Connect Claude">
        <p className="help-text">
          Let Claude manage your tailnets for you. Claude acts as @{user?.handle} with exactly your
          permissions{user?.isOperator ? ", including instance operator tools" : ""}.
        </p>
        <CopyField value={url} label="Claude connector URL" />
        <ol className="steps">
          <li>In Claude, add a custom connector and paste this URL.</li>
          <li>When Claude opens your browser, sign in with your Bluesky account.</li>
          <li>Review the request and click Approve.</li>
        </ol>
      </Card>
      <Card title="Connected apps">
        {loading ? (
          <Loading />
        ) : connections.length === 0 ? (
          <EmptyState>No apps connected.</EmptyState>
        ) : (
          <ul className="item-list">
            {connections.map((c) => (
              <li key={c.id} className="item-row">
                <div className="item-info">
                  <span className="item-header">
                    <span className="item-name">{c.clientName}</span>
                    {c.operator && <Badge variant="role">operator access</Badge>}
                  </span>
                  <span className="item-detail">
                    Connected {relativeTime(c.createdAt)}
                    {c.lastUsedAt ? ` · last used ${relativeTime(c.lastUsedAt)}` : " · never used"}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn-sm btn-danger"
                  disabled={busy}
                  onClick={() => { void revoke(c); }}
                  aria-label={`Revoke ${c.clientName}`}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
