import { useState } from "react";
import { agentsService } from "../services/agents";
import { useApp } from "../hooks/useAppState";
import { useToast } from "../components/Toast";
import { useTenantData } from "../hooks/useTenantData";
import { useTenantMutation } from "../hooks/useMutation";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { Loading } from "../components/Loading";
import { CodeBlock } from "../components/CodeBlock";
import { useConfirm } from "../components/ConfirmDialog";
import { Badge, StatusBadge } from "../components/Badge";
import { relativeTime } from "../lib/utils";
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
  const confirm = useConfirm();

  const togglePerm = (perm: string) => {
    setSelectedPerms((prev) =>
      prev.includes(perm) ? prev.filter((p) => p !== perm) : [...prev, perm],
    );
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentTenant || !name.trim() || creating) return;
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
    if (!(await confirm({ title: "Revoke this agent token?", message: "This cannot be undone.", confirmLabel: "Revoke token", danger: true }))) return;
    await mutate(
      `/agent-tokens/${tokenId}`,
      { method: "DELETE" },
      { successMsg: "Token revoked", reload },
    );
  };

  const getStatus = (token: AgentToken): "active" | "expired" | "revoked" => {
    if (token.status === "revoked") return "revoked";
    if (new Date(token.expiresAt).getTime() < Date.now()) return "expired";
    return "active";
  };

  if (loading) return <Loading />;

  return (
    <div className="tab-content">
      {hasPerm("create_agent_tokens") && (
        <Card title="Create an agent token">
          <form className="form-stack" onSubmit={handleCreate}>
            <div className="field-row">
              <div className="field">
                <label htmlFor="agent-token-name">Token name</label>
                <input
                  id="agent-token-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="agent-token-expiry">Expires in</label>
                <select
                  id="agent-token-expiry"
                  value={expiryDays}
                  onChange={(e) => setExpiryDays(Number(e.target.value))}
                >
                  <option value={7}>7 days</option>
                  <option value={30}>30 days</option>
                  <option value={90}>90 days</option>
                  <option value={365}>365 days</option>
                </select>
              </div>
            </div>
            <fieldset className="field">
              <legend>Permissions</legend>
              <div className="chip-list">
                {allPerms.map((perm) => (
                  <button
                    key={perm}
                    type="button"
                    className="chip"
                    aria-pressed={selectedPerms.includes(perm)}
                    onClick={() => togglePerm(perm)}
                  >
                    {perm}
                  </button>
                ))}
              </div>
            </fieldset>
            <button type="submit" disabled={creating || !name.trim()}>
              {creating ? "Creating…" : "Create token"}
            </button>
          </form>
        </Card>
      )}

      {createdToken && (
        <Card title="New token">
          <p className="notice" role="alert">
            Copy this token now. It will not be shown again.
          </p>
          <CodeBlock value={createdToken} label="Agent token" />
        </Card>
      )}

      <Card title="Agent tokens">
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
                        <Badge variant="stopped">expired</Badge>
                      ) : (
                        <StatusBadge status={status} />
                      )}
                    </div>
                    <div className="item-meta">
                      <span>Prefix: <span className="mono">{token.tokenPrefix}…</span></span>
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
                    {token.permissions.length > 0 && (
                      <ul className="chip-list mt-4" aria-label="Permissions">
                        {token.permissions.map((p) => (
                          <li key={p} className="chip">{p}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                  {status === "active" && hasPerm("manage_agent_tokens") && (
                    <button
                      type="button"
                      className="btn-sm btn-danger"
                      aria-label={`Revoke token ${token.name}`}
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
