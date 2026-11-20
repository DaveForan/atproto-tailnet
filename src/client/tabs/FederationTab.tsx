import { useCallback, useEffect, useState } from "react";
import { federationService } from "../services/federation";
import { useApp } from "../hooks/useAppState";
import { useToast } from "../components/Toast";
import { useTenantMutation } from "../hooks/useMutation";
import { Card } from "../components/Card";
import { Badge, StatusBadge } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { Loading } from "../components/Loading";
import { CodeBlock } from "../components/CodeBlock";
import { useConfirm } from "../components/ConfirmDialog";
import { errorMessage, relativeTime } from "../lib/utils";
import type {
  FederationLink,
  BrokerData,
  FederationScope,
  ScopePolicyConfig,
  ScopeUpdate,
} from "../lib/types";
import { LoadError } from "../components/LoadError";

const ALL_SCOPES: FederationScope[] = ["local", "regional", "global"];
const DEFAULT_POLICY: ScopePolicyConfig = { autoAccept: false, verification: "standard" };

export function FederationTab() {
  const { currentTenant, hasPerm } = useApp();
  const { toastError } = useToast();
  const { mutate, busy } = useTenantMutation();
  const confirm = useConfirm();
  const canManage = hasPerm("manage_settings");

  const [links, setLinks] = useState<FederationLink[]>([]);
  const [posture, setPosture] = useState("selective");
  const [did, setDid] = useState("");
  const [broker, setBroker] = useState<BrokerData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Request form state
  const [targetSlug, setTargetSlug] = useState("");
  const [requestMessage, setRequestMessage] = useState("");
  const [requestCidrs, setRequestCidrs] = useState("");

  // Accept form state: per-link CIDRs
  const [acceptCidrs, setAcceptCidrs] = useState<Record<string, string>>({});

  // Scope edit state
  const [scopes, setScopes] = useState<FederationScope[]>(["regional"]);
  const [region, setRegion] = useState("");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [policies, setPolicies] = useState<Partial<Record<FederationScope, ScopePolicyConfig>>>({});

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
      setScopes(data.scopes);
      setRegion(data.region ?? "");
      setLat(data.coordinates ? String(data.coordinates[0]) : "");
      setLon(data.coordinates ? String(data.coordinates[1]) : "");
      setPolicies(data.scopePolicies ?? {});
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

  const loadAll = useCallback(async () => {
    if (!currentTenant) return;
    try {
      const results = await Promise.allSettled([
        loadLinks(), loadPosture(), loadScope(), loadDid(), loadBroker(),
      ]);
      const failure = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      setLoadError(failure ? `Some federation data failed to load: ${errorMessage(failure.reason, "unknown error")}` : null);
    } finally {
      setLoading(false);
    }
  }, [loadLinks, loadPosture, loadScope, loadDid, loadBroker]);

  useEffect(() => { void loadAll(); }, [loadAll]);

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
        targetSlug: targetSlug.trim(),
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
    if (!(await confirm({ title: "Revoke this federation link?", message: "This cannot be undone.", confirmLabel: "Revoke link", danger: true }))) return;
    await mutate(`/federation/${id}/revoke`, { method: "POST" }, {
      successMsg: "Federation link revoked",
      reload: loadLinks,
    });
  };

  const savePosture = async (e: React.FormEvent) => {
    e.preventDefault();
    await mutate("/federation/posture", {
      method: "PUT",
      body: JSON.stringify({ posture }),
    }, { successMsg: "Federation posture updated" });
  };

  const toggleScope = (sc: FederationScope, on: boolean) => {
    setScopes((prev) =>
      on ? ALL_SCOPES.filter((x) => x === sc || prev.includes(x)) : prev.filter((x) => x !== sc),
    );
  };

  const setPolicy = (sc: FederationScope, patch: Partial<ScopePolicyConfig>) => {
    setPolicies((prev) => ({ ...prev, [sc]: { ...DEFAULT_POLICY, ...prev[sc], ...patch } }));
  };

  const saveScope = async (e: React.FormEvent) => {
    e.preventDefault();
    if (scopes.length === 0) {
      toastError("Select at least one scope");
      return;
    }
    const body: ScopeUpdate = { scopes };
    if (region.trim()) body.region = region.trim();
    if (lat.trim() || lon.trim()) {
      const la = Number(lat);
      const lo = Number(lon);
      if (!lat.trim() || !lon.trim() || Number.isNaN(la) || Number.isNaN(lo)) {
        toastError("Coordinates need both a numeric latitude and longitude");
        return;
      }
      body.coordinates = [la, lo];
    }
    const scopePolicies: Partial<Record<FederationScope, ScopePolicyConfig>> = {};
    for (const sc of scopes) {
      if (policies[sc]) scopePolicies[sc] = policies[sc];
    }
    if (Object.keys(scopePolicies).length > 0) body.scopePolicies = scopePolicies;
    await mutate("/federation/scope", {
      method: "PUT",
      body: JSON.stringify(body),
    }, { successMsg: "Federation scope updated", reload: loadScope });
  };

  const rotateDid = async () => {
    if (!(await confirm({
      title: "Rotate the collective DID?",
      message: "This invalidates all federation sessions and credentials signed under the current DID.",
      confirmLabel: "Rotate DID",
      danger: true,
    }))) return;
    await mutate("/federation/did/rotate", { method: "POST" }, {
      successMsg: "Collective DID rotated",
      reload: loadDid,
    });
  };

  if (loading) return <Loading />;

  const peer = (link: FederationLink) => link.peerName || link.peerDid;
  const cidrs = (label: string, list?: string[] | null) =>
    list && list.length > 0 ? (
      <span className="item-detail">
        {label}: <span className="mono">{list.join(", ")}</span>
      </span>
    ) : null;

  return (
    <div className="tab-content">
      <LoadError error={loadError} onRetry={loadAll} />
      {/* Request federation */}
      <Card title="Request federation">
        <form className="form-stack" onSubmit={requestFederation}>
          <div className="field">
            <label htmlFor="fed-target">Target collective slug</label>
            <input
              id="fed-target"
              type="text"
              className="mono"
              autoCapitalize="none"
              spellCheck={false}
              value={targetSlug}
              onChange={(e) => setTargetSlug(e.target.value)}
              required
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="fed-message">Message (optional)</label>
              <textarea
                id="fed-message"
                value={requestMessage}
                onChange={(e) => setRequestMessage(e.target.value)}
                rows={3}
              />
            </div>
            <div className="field">
              <label htmlFor="fed-cidrs">CIDRs to share (one per line)</label>
              <textarea
                id="fed-cidrs"
                className="mono"
                spellCheck={false}
                value={requestCidrs}
                onChange={(e) => setRequestCidrs(e.target.value)}
                rows={3}
              />
            </div>
          </div>
          <button type="submit" disabled={busy || !canManage}>
            Send request
          </button>
        </form>
      </Card>

      {/* Incoming pending */}
      <Card title="Incoming requests">
        {incomingPending.length > 0 ? (
          <ul className="post-list">
            {incomingPending.map((link) => (
              <li key={link.id} className="post-card">
                <div className="post-head">
                  <h4>{peer(link)}</h4>
                  <span className="text-dim text-sm">{relativeTime(link.createdAt)}</span>
                  <StatusBadge status={link.status} />
                </div>
                {cidrs("Their CIDRs", link.peerCidrs)}
                {link.message && <p className="post-desc">{link.message}</p>}
                <form
                  className="form-stack"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void acceptLink(link.id);
                  }}
                >
                  <div className="field">
                    <label htmlFor={`fed-accept-${link.id}`}>Your CIDRs to share (one per line)</label>
                    <textarea
                      id={`fed-accept-${link.id}`}
                      className="mono"
                      spellCheck={false}
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
                  <div className="btn-group">
                    <button type="submit" className="btn-sm" disabled={busy || !canManage}>
                      Accept
                    </button>
                    <button
                      type="button"
                      className="btn-sm btn-danger btn-apart"
                      onClick={() => rejectLink(link.id)}
                      disabled={busy || !canManage}
                    >
                      Reject
                    </button>
                  </div>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState>No incoming requests.</EmptyState>
        )}
      </Card>

      {/* Outgoing pending */}
      <Card title="Outgoing requests">
        {outgoingPending.length > 0 ? (
          <ul className="item-list">
            {outgoingPending.map((link) => (
              <li key={link.id} className="item-row">
                <div className="item-info">
                  <span className="item-header">
                    <span className="item-name">{peer(link)}</span>
                    <StatusBadge status={link.status} />
                  </span>
                  {cidrs("Local CIDRs", link.localCidrs)}
                  <span className="item-detail">{relativeTime(link.createdAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState>No outgoing requests.</EmptyState>
        )}
      </Card>

      {/* Active links */}
      <Card title="Active links">
        {active.length > 0 ? (
          <ul className="item-list">
            {active.map((link) => (
              <li key={link.id} className="item-row">
                <div className="item-info">
                  <span className="item-header">
                    <span className="item-name">{peer(link)}</span>
                    <Badge variant="role">{link.direction}</Badge>
                  </span>
                  {cidrs("Local CIDRs", link.localCidrs)}
                  {cidrs("Peer CIDRs", link.peerCidrs)}
                </div>
                <button
                  type="button"
                  className="btn-sm btn-danger"
                  aria-label={`Revoke link with ${peer(link)}`}
                  onClick={() => revokeLink(link.id)}
                  disabled={busy || !canManage}
                >
                  Revoke
                </button>
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
                  <span className="item-header">
                    <span className="item-name">{peer(link)}</span>
                    <StatusBadge status={link.status} />
                    <Badge variant="role">{link.direction}</Badge>
                  </span>
                  <span className="item-detail">{relativeTime(link.updatedAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState>No federation history.</EmptyState>
        )}
      </Card>

      {/* Posture */}
      <Card title="Federation posture">
        <form className="field" onSubmit={savePosture}>
          <label htmlFor="fed-posture">Who may federate with this tailnet</label>
          <div className="inline-form">
            <select
              id="fed-posture"
              value={posture}
              onChange={(e) => setPosture(e.target.value)}
            >
              <option value="open">Open</option>
              <option value="selective">Selective</option>
              <option value="closed">Closed</option>
            </select>
            <button type="submit" disabled={busy || !canManage}>
              Save posture
            </button>
          </div>
        </form>
      </Card>

      {/* Scoping */}
      <Card title="Federation scope">
        <form className="form-stack" onSubmit={saveScope} noValidate>
          <fieldset className="check-list">
            <legend>Scopes</legend>
            {ALL_SCOPES.map((sc) => {
              const enabled = scopes.includes(sc);
              const policy = policies[sc] ?? DEFAULT_POLICY;
              return (
                <div key={sc} className="scope-row">
                  <label className="check-inline">
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(e) => toggleScope(sc, e.target.checked)}
                    />
                    {sc}
                  </label>
                  {enabled && (
                    <>
                      <label className="check-inline">
                        <input
                          type="checkbox"
                          checked={policy.autoAccept}
                          onChange={(e) => setPolicy(sc, { autoAccept: e.target.checked })}
                        />
                        Auto-accept
                      </label>
                      <select
                        className="select-compact"
                        aria-label={`Verification for the ${sc} scope`}
                        value={policy.verification}
                        onChange={(e) =>
                          setPolicy(sc, { verification: e.target.value as ScopePolicyConfig["verification"] })
                        }
                      >
                        <option value="standard">Standard verification</option>
                        <option value="strict">Strict verification</option>
                      </select>
                    </>
                  )}
                </div>
              );
            })}
          </fieldset>
          <div className="field-row">
            <div className="field">
              <label htmlFor="fed-region">Region (UN M49 3-digit code, optional)</label>
              <input
                id="fed-region"
                type="text"
                inputMode="numeric"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                pattern="\d{3}"
                maxLength={3}
                placeholder="e.g. 021"
              />
            </div>
            <div className="field">
              <label htmlFor="fed-lat">Latitude (optional)</label>
              <input
                id="fed-lat"
                type="number"
                step="any"
                min={-90}
                max={90}
                value={lat}
                onChange={(e) => setLat(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="fed-lon">Longitude (optional)</label>
              <input
                id="fed-lon"
                type="number"
                step="any"
                min={-180}
                max={180}
                value={lon}
                onChange={(e) => setLon(e.target.value)}
              />
            </div>
          </div>
          <button type="submit" disabled={busy || !canManage}>
            Save scope
          </button>
        </form>
      </Card>

      {/* Collective DID */}
      <Card title="Collective identity">
        {did ? (
          <CodeBlock value={did} label="Collective DID" />
        ) : (
          <EmptyState>No DID assigned.</EmptyState>
        )}
        <div className="form-section">
          <p className="help-text">
            Rotating the DID invalidates all federation sessions and credentials signed under the current one.
          </p>
          <button type="button" className="btn-sm btn-danger" onClick={rotateDid} disabled={busy || !canManage}>
            Rotate DID
          </button>
        </div>
      </Card>

      {/* Broker status */}
      <Card title="Broker status">
        {broker ? (
          <div className="stats-row">
            <div className="stat-card">
              <div className="stat-value">{broker.sessionCount}</div>
              <div className="stat-label">Sessions</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{broker.importedRoutes}</div>
              <div className="stat-label">Imported routes</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{broker.exportedRoutes}</div>
              <div className="stat-label">Exported routes</div>
            </div>
          </div>
        ) : (
          <EmptyState>Broker data unavailable.</EmptyState>
        )}
      </Card>
    </div>
  );
}
