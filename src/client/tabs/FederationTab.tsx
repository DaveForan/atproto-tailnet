import { useCallback, useEffect, useState } from "react";
import { federationService } from "../services/federation";
import { useApp } from "../hooks/useAppState";
import { useToast } from "../components/Toast";
import { useTenantMutation } from "../hooks/useMutation";
import { Card } from "../components/Card";
import { Badge, StatusBadge } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { relativeTime } from "../lib/utils";
import type { FederationLink, PostureData, ScopeData, DidData, BrokerData } from "../lib/types";

export function FederationTab() {
  const { currentTenant, hasPerm } = useApp();
  const { toastError } = useToast();
  const { mutate, busy } = useTenantMutation();

  const [links, setLinks] = useState<FederationLink[]>([]);
  const [posture, setPosture] = useState("selective");
  const [scope, setScope] = useState<ScopeData>({ allowedCidrs: [], blockedCidrs: [] });
  const [did, setDid] = useState("");
  const [broker, setBroker] = useState<BrokerData | null>(null);
  const [loading, setLoading] = useState(true);

  // Request form state
  const [targetSlug, setTargetSlug] = useState("");
  const [requestMessage, setRequestMessage] = useState("");
  const [requestCidrs, setRequestCidrs] = useState("");

  // Accept form state: per-link CIDRs
  const [acceptCidrs, setAcceptCidrs] = useState<Record<string, string>>({});

  // Scope edit state
  const [allowedCidrsText, setAllowedCidrsText] = useState("");
  const [blockedCidrsText, setBlockedCidrsText] = useState("");

  const loadLinks = useCallback(async () => {
    if (!currentTenant) return;
    const data = await federationService.getLinks(currentTenant.id);
    setLinks(data?.links ?? []);
  }, [currentTenant?.id]);

  const loadPosture = useCallback(async () => {
    if (!currentTenant) return;
    const data = await federationService.getPosture(currentTenant.id);
    if (data) setPosture(data.posture);
  }, [currentTenant?.id]);

  const loadScope = useCallback(async () => {
    if (!currentTenant) return;
    const data = await federationService.getScope(currentTenant.id);
    if (data) {
      setScope(data);
      setAllowedCidrsText(data.allowedCidrs.join("\n"));
      setBlockedCidrsText(data.blockedCidrs.join("\n"));
    }
  }, [currentTenant?.id]);

  const loadDid = useCallback(async () => {
    if (!currentTenant) return;
    const data = await federationService.getDid(currentTenant.id);
    if (data) setDid(data.did);
  }, [currentTenant?.id]);

  const loadBroker = useCallback(async () => {
    if (!currentTenant) return;
    const data = await federationService.getBroker(currentTenant.id);
    setBroker(data);
  }, [currentTenant?.id]);

  useEffect(() => {
    if (!currentTenant) return;
    const loadAll = async () => {
      try {
        const results = await Promise.allSettled([
          loadLinks(), loadPosture(), loadScope(), loadDid(), loadBroker(),
        ]);
        const failures = results.filter((r) => r.status === "rejected");
        if (failures.length > 0) {
          toastError("Some federation data failed to load");
        }
      } finally {
        setLoading(false);
      }
    };
    loadAll();
  }, [loadLinks, loadPosture, loadScope, loadDid, loadBroker]);

  // Categorize links
  const outgoingPending = links.filter(
    (l) => l.direction === "outgoing" && l.status === "pending",
  );
  const incomingPending = links.filter(
    (l) => l.direction === "incoming" && l.status === "pending",
  );
  const active = links.filter((l) => l.status === "active");
  const history = links.filter(
    (l) => l.status === "rejected" || l.status === "revoked",
  );

  const requestFederation = async (e: React.FormEvent) => {
    e.preventDefault();
    const cidrs = requestCidrs
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const ok = await mutate("/federation", {
      method: "POST",
      body: JSON.stringify({
        peerSlug: targetSlug,
        message: requestMessage || undefined,
        cidrs: cidrs.length > 0 ? cidrs : undefined,
      }),
    }, { successMsg: "Federation request sent", reload: loadLinks });
    if (ok) {
      setTargetSlug("");
      setRequestMessage("");
      setRequestCidrs("");
    }
  };

  const acceptLink = async (id: string) => {
    const cidrs = (acceptCidrs[id] ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const ok = await mutate(`/federation/${id}/accept`, {
      method: "POST",
      body: JSON.stringify({ cidrs: cidrs.length > 0 ? cidrs : undefined }),
    }, { successMsg: "Federation link accepted", reload: loadLinks });
    if (ok) {
      setAcceptCidrs((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  };

  const rejectLink = async (id: string) => {
    await mutate(`/federation/${id}/reject`, { method: "POST" }, {
      successMsg: "Federation link rejected",
      reload: loadLinks,
    });
  };

  const revokeLink = async (id: string) => {
    if (!confirm("Revoke this federation link? This cannot be undone.")) return;
    await mutate(`/federation/${id}/revoke`, { method: "POST" }, {
      successMsg: "Federation link revoked",
      reload: loadLinks,
    });
  };

  const savePosture = async () => {
    await mutate("/federation/posture", {
      method: "PUT",
      body: JSON.stringify({ posture }),
    }, { successMsg: "Federation posture updated" });
  };

  const saveScope = async () => {
    const allowed = allowedCidrsText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const blocked = blockedCidrsText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    await mutate("/federation/scope", {
      method: "PUT",
      body: JSON.stringify({ allowedCidrs: allowed, blockedCidrs: blocked }),
    }, { successMsg: "Federation scope updated", reload: loadScope });
  };

  const rotateDid = async () => {
    if (!confirm("Rotate DID? This invalidates all federation sessions and credentials signed under the current DID.")) return;
    await mutate("/federation/did/rotate", { method: "POST" }, {
      successMsg: "Collective DID rotated",
      reload: loadDid,
    });
  };

  if (loading) return <div className="loading">Loading...</div>;

  return (
    <div className="tab-content">
      {/* Request federation */}
      <Card title="Request Federation">
        <form className="inline-form" onSubmit={requestFederation}>
          <input
            type="text"
            placeholder="Target collective slug"
            value={targetSlug}
            onChange={(e) => setTargetSlug(e.target.value)}
            required
          />
          <textarea
            placeholder="Message (optional)"
            value={requestMessage}
            onChange={(e) => setRequestMessage(e.target.value)}
            rows={2}
          />
          <textarea
            placeholder="CIDRs to share (one per line)"
            value={requestCidrs}
            onChange={(e) => setRequestCidrs(e.target.value)}
            rows={3}
          />
          <button type="submit" className="btn-primary" disabled={busy || !hasPerm("manage_settings")}>
            Send Request
          </button>
        </form>
      </Card>

      {/* Outgoing pending */}
      <Card title="Outgoing Pending">
        {outgoingPending.length > 0 ? (
          <ul className="item-list">
            {outgoingPending.map((link) => (
              <li key={link.id} className="item-row">
                <div className="item-info">
                  <span className="item-name">
                    {link.peerName || link.peerSlug}
                  </span>
                  <StatusBadge status={link.status} />
                  {link.localCidrs && link.localCidrs.length > 0 && (
                    <span className="item-detail">
                      Local CIDRs: {link.localCidrs.join(", ")}
                    </span>
                  )}
                  <span className="item-meta">
                    {relativeTime(link.createdAt)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState>No outgoing pending requests.</EmptyState>
        )}
      </Card>

      {/* Incoming pending */}
      <Card title="Incoming Pending">
        {incomingPending.length > 0 ? (
          <ul className="item-list">
            {incomingPending.map((link) => (
              <li key={link.id} className="item-row">
                <div className="item-info">
                  <span className="item-name">
                    {link.peerName || link.peerSlug}
                  </span>
                  {link.peerCidrs && link.peerCidrs.length > 0 && (
                    <span className="item-detail">
                      Their CIDRs: {link.peerCidrs.join(", ")}
                    </span>
                  )}
                  {link.message && (
                    <span className="item-detail">
                      Message: {link.message}
                    </span>
                  )}
                  <span className="item-meta">
                    {relativeTime(link.createdAt)}
                  </span>
                  <textarea
                    placeholder="Your CIDRs to share (one per line)"
                    value={acceptCidrs[link.id] ?? ""}
                    onChange={(e) =>
                      setAcceptCidrs((prev) => ({
                        ...prev,
                        [link.id]: e.target.value,
                      }))
                    }
                    rows={2}
                  />
                </div>
                <div className="item-actions">
                  <button
                    className="btn-sm btn-primary"
                    onClick={() => acceptLink(link.id)}
                    disabled={busy || !hasPerm("manage_settings")}
                  >
                    Accept
                  </button>
                  <button
                    className="btn-sm btn-danger"
                    onClick={() => rejectLink(link.id)}
                    disabled={busy || !hasPerm("manage_settings")}
                  >
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState>No incoming pending requests.</EmptyState>
        )}
      </Card>

      {/* Active links */}
      <Card title="Active Links">
        {active.length > 0 ? (
          <ul className="item-list">
            {active.map((link) => (
              <li key={link.id} className="item-row">
                <div className="item-info">
                  <span className="item-name">
                    {link.peerName || link.peerSlug}
                  </span>
                  <Badge variant="role">{link.direction}</Badge>
                  {link.localCidrs && link.localCidrs.length > 0 && (
                    <span className="item-detail">
                      Local CIDRs: {link.localCidrs.join(", ")}
                    </span>
                  )}
                  {link.peerCidrs && link.peerCidrs.length > 0 && (
                    <span className="item-detail">
                      Peer CIDRs: {link.peerCidrs.join(", ")}
                    </span>
                  )}
                </div>
                <div className="item-actions">
                  <button
                    className="btn-sm btn-danger"
                    onClick={() => revokeLink(link.id)}
                    disabled={busy || !hasPerm("manage_settings")}
                  >
                    Revoke
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState>No active federation links.</EmptyState>
        )}
      </Card>

      {/* History */}
      <Card title="History">
        {history.length > 0 ? (
          <ul className="item-list dimmed">
            {history.map((link) => (
              <li key={link.id} className="item-row">
                <div className="item-info">
                  <span className="item-name">
                    {link.peerName || link.peerSlug}
                  </span>
                  <StatusBadge status={link.status} />
                  <Badge variant="role">{link.direction}</Badge>
                  <span className="item-meta">
                    {relativeTime(link.updatedAt)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState>No federation history.</EmptyState>
        )}
      </Card>

      {/* Posture */}
      <Card title="Federation Posture">
        <div className="inline-form">
          <select
            value={posture}
            onChange={(e) => setPosture(e.target.value)}
          >
            <option value="open">Open</option>
            <option value="selective">Selective</option>
            <option value="closed">Closed</option>
          </select>
          <button className="btn-primary" onClick={savePosture} disabled={busy || !hasPerm("manage_settings")}>
            Save Posture
          </button>
        </div>
      </Card>

      {/* Scoping */}
      <Card title="Federation Scope">
        <div className="inline-form">
          <label className="form-label">Allowed CIDRs (one per line)</label>
          <textarea
            value={allowedCidrsText}
            onChange={(e) => setAllowedCidrsText(e.target.value)}
            rows={4}
          />
          <label className="form-label">Blocked CIDRs (one per line)</label>
          <textarea
            value={blockedCidrsText}
            onChange={(e) => setBlockedCidrsText(e.target.value)}
            rows={4}
          />
          <button className="btn-primary" onClick={saveScope} disabled={busy || !hasPerm("manage_settings")}>
            Save Scope
          </button>
        </div>
      </Card>

      {/* Collective DID */}
      <Card title="Collective Identity">
        <div className="inline-form">
          <code className="code-block">{did || "No DID assigned"}</code>
          <button className="btn-sm btn-danger" onClick={rotateDid} disabled={busy || !hasPerm("manage_settings")}>
            Rotate DID
          </button>
        </div>
      </Card>

      {/* Broker status */}
      <Card title="Broker Status">
        {broker ? (
          <div className="stats-row">
            <div className="stat-card">
              <div className="stat-value">{broker.sessionCount}</div>
              <div className="stat-label">Sessions</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{broker.importedRoutes}</div>
              <div className="stat-label">Imported Routes</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{broker.exportedRoutes}</div>
              <div className="stat-label">Exported Routes</div>
            </div>
          </div>
        ) : (
          <EmptyState>Broker data unavailable.</EmptyState>
        )}
      </Card>
    </div>
  );
}
