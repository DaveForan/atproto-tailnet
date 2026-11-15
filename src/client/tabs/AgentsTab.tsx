import { useState } from "react";
import { agentsService } from "../services/agents";
import { useApp } from "../hooks/useAppState";
import { useToast } from "../components/Toast";
import { useTenantData } from "../hooks/useTenantData";
import { useTenantMutation } from "../hooks/useMutation";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { StatusBadge } from "../components/Badge";
import { copyToClipboard, relativeTime } from "../lib/utils";
import type { AgentToken } from "../lib/types";

export function AgentsTab() {
  const { currentTenant, allPerms, hasPerm } = useApp();
  const { toast, toastError } = useToast();
  const { data: tokens, loading, reload } = useTenantData<AgentToken[]>("/agent-tokens", []);
  const { mutate, busy } = useTenantMutation();

  const [name, setName] = useState("");
  const [expiryDays, setExpiryDays] = useState(30);
  const [selectedPerms, setSelectedPerms] = useState<string[]>([]);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const togglePerm = (perm: string) => {
    setSelectedPerms((prev) =>
      prev.includes(perm) ? prev.filter((p) => p !== perm) : [...prev, perm],
    );
  };

  const handleCreate = async () => {
    if (!currentTenant || !name.trim()) return;
    setCreating(true);
    try {
      const result = await agentsService.createAgentToken(currentTenant.id, {
        name: name.trim(),
        expiresInDays: expiryDays,
        permissions: selectedPerms,
      });
      if (result?.token) {
        setCreatedToken(result.token);
      }
      toast("Agent token created");
      setName("");
      setSelectedPerms([]);
      await reload();
    } catch (e) {
      toastError(
        e instanceof Error ? e.message : "Failed to create agent token",
      );
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (tokenId: string) => {
    if (!confirm("Revoke this agent token? This cannot be undone.")) return;
    await mutate(
      `/agent-tokens/${tokenId}/revoke`,
      { method: "POST" },
      { successMsg: "Token revoked", reload },
    );
  };

  const getStatus = (token: AgentToken): "active" | "expired" | "revoked" => {
    if (token.status === "revoked") return "revoked";
    if (new Date(token.expiresAt).getTime() < Date.now()) return "expired";
    return "active";
  };

  if (loading) return <div className="loading">Loading...</div>;

  return (
    <div className="tab-content">
      {hasPerm("create_agent_tokens") && (
        <Card title="Create Agent Token">
          <div className="form-stack">
            <input
              type="text"
              placeholder="Token name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <div className="form-row">
              <label>Expires in:</label>
              <select
                value={expiryDays}
                onChange={(e) => setExpiryDays(Number(e.target.value))}
              >
                <option value={7}>7 days</option>
                <option value={30}>30 days</option>
                <option value={90}>90 days</option>
                <option value={365}>365 days</option>
              </select>
            </div>
            <div className="form-field">
              <label>Permissions:</label>
              <div className="chip-list">
                {allPerms.map((perm) => (
                  <button
                    key={perm}
                    className={`chip ${selectedPerms.includes(perm) ? "chip-active" : ""}`}
                    onClick={() => togglePerm(perm)}
                  >
                    {perm}
                  </button>
                ))}
              </div>
            </div>
            <button
              className="btn-primary"
              onClick={handleCreate}
              disabled={creating || !name.trim()}
            >
              {creating ? "Creating..." : "Create Token"}
            </button>
          </div>
        </Card>
      )}

      {createdToken && (
        <Card title="New Token">
          <p className="warning-text">
            Copy this token now. It will not be shown again.
          </p>
          <div className="code-block-wrapper">
            <code className="code-block">{createdToken}</code>
            <button
              className="btn-sm btn-ghost"
              onClick={() => {
                copyToClipboard(createdToken);
                toast("Copied to clipboard");
              }}
            >
              Copy
            </button>
          </div>
        </Card>
      )}

      <Card title="Agent Tokens">
        {tokens.length === 0 ? (
          <EmptyState>No agent tokens created yet.</EmptyState>
        ) : (
          <ul className="item-list">
            {tokens.map((token) => {
              const status = getStatus(token);
              return (
                <li key={token.id} className="item-row">
                  <div className="item-info">
                    <div className="item-header">
                      <span className="item-name">{token.name}</span>
                      {status === "expired" ? (
                        <span className="badge badge-stopped">expired</span>
                      ) : (
                        <StatusBadge status={status} />
                      )}
                    </div>
                    <div className="item-meta">
                      <span>Prefix: {token.tokenPrefix}...</span>
                      {token.ownerHandle && (
                        <span>Owner: {token.ownerHandle}</span>
                      )}
                      <span>
                        Expires: {new Date(token.expiresAt).toLocaleDateString()}
                      </span>
                      {token.lastUsedAt && (
                        <span>Last used: {relativeTime(token.lastUsedAt)}</span>
                      )}
                    </div>
                    <div className="chip-list">
                      {token.permissions.map((p) => (
                        <span key={p} className="chip chip-active">
                          {p}
                        </span>
                      ))}
                    </div>
                  </div>
                  {status === "active" && hasPerm("manage_agent_tokens") && (
                    <button
                      className="btn-sm btn-danger"
                      onClick={() => handleRevoke(token.id)}
                      disabled={busy}
                    >
                      Revoke
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
