import { useCallback, useEffect, useId, useState } from "react";
import { networkService } from "../services/network";
import { useApp } from "../hooks/useAppState";
import { useToast } from "../components/Toast";
import { useTenantMutation } from "../hooks/useMutation";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { Loading } from "../components/Loading";
import { Badge } from "../components/Badge";
import { Toggle } from "../components/Toggle";
import type { DerpConfig, DerpNode, DerpRegion } from "../lib/types";

export function DerpTab() {
  const { currentTenant } = useApp();
  const { toast, toastError } = useToast();
  const { mutate, busy } = useTenantMutation();
  const [config, setConfig] = useState<DerpConfig>({
    regions: [],
    embeddedDerpEnabled: false,
    usePublicDerp: true,
  });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!currentTenant) return;
    try {
      const data = await networkService.getDerp(currentTenant.id);
      if (data) setConfig(data);
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Failed to load DERP config");
    } finally {
      setLoading(false);
    }
  }, [currentTenant?.id]);

  useEffect(() => { load().catch(() => {}); }, [load]);

  const updateRegions = (regions: DerpRegion[]) => {
    setConfig((c) => ({ ...c, regions }));
  };

  const addRegion = (region: DerpRegion) => {
    updateRegions([...config.regions, region]);
    toast("Region added (unsaved)");
  };

  const removeRegion = (idx: number) => {
    updateRegions(config.regions.filter((_, i) => i !== idx));
    toast("Region removed (unsaved)");
  };

  const addNode = (regionIdx: number, node: DerpNode) => {
    const regions = config.regions.map((r, i) =>
      i === regionIdx ? { ...r, nodes: [...r.nodes, node] } : r,
    );
    updateRegions(regions);
    toast("Node added (unsaved)");
  };

  const removeNode = (regionIdx: number, nodeIdx: number) => {
    const regions = config.regions.map((r, i) =>
      i === regionIdx
        ? { ...r, nodes: r.nodes.filter((_, j) => j !== nodeIdx) }
        : r,
    );
    updateRegions(regions);
    toast("Node removed (unsaved)");
  };

  const save = async () => {
    await mutate(
      "/derp",
      { method: "PUT", body: JSON.stringify(config) },
      { successMsg: "DERP configuration saved", reload: load },
    );
  };

  if (loading) return <Loading />;

  return (
    <div className="tab-content">
      <Card title="DERP relays">
        <p className="card-description">
          DERP (Designated Encrypted Relay for Packets) relays help devices
          communicate when direct connections are not possible.
        </p>
        <div className="toggle-group">
          <Toggle
            label="Use public DERP relays"
            description="Allow connections through public relay infrastructure"
            checked={config.usePublicDerp}
            onChange={(v) => setConfig((c) => ({ ...c, usePublicDerp: v }))}
          />
          <Toggle
            label="Embedded DERP server"
            description="Run a DERP relay inside this Headscale container (requires restart)"
            checked={config.embeddedDerpEnabled}
            onChange={(v) =>
              setConfig((c) => ({ ...c, embeddedDerpEnabled: v }))
            }
          />
        </div>
      </Card>

      <Card title="Custom DERP regions">
        {config.regions.length === 0 ? (
          <EmptyState>No custom DERP regions defined.</EmptyState>
        ) : (
          config.regions.map((region, rIdx) => (
            <RegionCard
              key={rIdx}
              region={region}
              onRemove={() => removeRegion(rIdx)}
              onAddNode={(node) => addNode(rIdx, node)}
              onRemoveNode={(nIdx) => removeNode(rIdx, nIdx)}
            />
          ))
        )}
        <AddRegionForm onAdd={addRegion} />
      </Card>

      <div className="form-footer">
        <button type="button" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save DERP configuration"}
        </button>
        <span className="text-dim text-sm">Changes to toggles, regions and nodes apply when you save.</span>
      </div>
    </div>
  );
}

function RegionCard({
  region,
  onRemove,
  onAddNode,
  onRemoveNode,
}: {
  region: DerpRegion;
  onRemove: () => void;
  onAddNode: (node: DerpNode) => void;
  onRemoveNode: (idx: number) => void;
}) {
  const [nodeName, setNodeName] = useState("");
  const [nodeHost, setNodeHost] = useState("");
  const [stunPort, setStunPort] = useState("");
  const [derpPort, setDerpPort] = useState("");
  const { toast } = useToast();
  const id = useId();

  const handleAddNode = (e: React.FormEvent) => {
    e.preventDefault();
    if (!nodeName.trim() || !nodeHost.trim()) {
      toast("Node name and hostname are required");
      return;
    }
    const node: DerpNode = { name: nodeName.trim(), hostname: nodeHost.trim() };
    if (stunPort) node.stunPort = parseInt(stunPort);
    if (derpPort) node.derpPort = parseInt(derpPort);
    onAddNode(node);
    setNodeName("");
    setNodeHost("");
    setStunPort("");
    setDerpPort("");
  };

  return (
    <section className="sub-card" aria-label={`Region ${region.regionName}`}>
      <div className="sub-card-header">
        <h4>
          {region.regionName}
          <Badge variant="role">{region.regionCode}</Badge>
          <span className="text-dim text-sm">ID {region.regionId}</span>
        </h4>
        <button type="button" className="btn-sm btn-danger" onClick={onRemove} aria-label={`Remove region ${region.regionName}`}>
          Remove region
        </button>
      </div>
      {region.nodes.length === 0 ? (
        <p className="help-text">This region has no nodes.</p>
      ) : (
        <ul className="item-list">
          {region.nodes.map((node, nIdx) => (
            <li key={nIdx} className="item-row">
              <div className="item-info">
                <span className="item-name">{node.name}</span>
                <span className="item-meta">
                  <span className="mono">{node.hostname}</span>
                  {node.stunPort != null && <span>STUN {node.stunPort}</span>}
                  {node.derpPort != null && <span>DERP {node.derpPort}</span>}
                </span>
              </div>
              <button type="button" className="btn-sm btn-ghost" onClick={() => onRemoveNode(nIdx)} aria-label={`Remove node ${node.name}`}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="form-stack mt-12" onSubmit={handleAddNode} aria-label={`Add a node to ${region.regionName}`}>
        <div className="field-row">
          <div className="field">
            <label htmlFor={`${id}-name`}>Node name</label>
            <input id={`${id}-name`} type="text" value={nodeName} onChange={(e) => setNodeName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={`${id}-host`}>Hostname</label>
            <input id={`${id}-host`} type="text" className="mono" spellCheck={false} value={nodeHost} onChange={(e) => setNodeHost(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={`${id}-stun`}>STUN port (optional)</label>
            <input id={`${id}-stun`} type="text" inputMode="numeric" value={stunPort} onChange={(e) => setStunPort(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={`${id}-derp`}>DERP port (optional)</label>
            <input id={`${id}-derp`} type="text" inputMode="numeric" value={derpPort} onChange={(e) => setDerpPort(e.target.value)} />
          </div>
        </div>
        <button type="submit" className="btn-sm btn-ghost">Add node</button>
      </form>
    </section>
  );
}

function AddRegionForm({ onAdd }: { onAdd: (region: DerpRegion) => void }) {
  const [regionId, setRegionId] = useState("");
  const [regionCode, setRegionCode] = useState("");
  const [regionName, setRegionName] = useState("");
  const [nodeName, setNodeName] = useState("");
  const [nodeHost, setNodeHost] = useState("");
  const [stunPort, setStunPort] = useState("");
  const [derpPort, setDerpPort] = useState("");
  const { toast } = useToast();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const id = parseInt(regionId);
    if (!id || id < 900 || id > 999) {
      toast("Region ID must be between 900 and 999");
      return;
    }
    if (!regionCode.trim()) { toast("Region code is required"); return; }
    if (!regionName.trim()) { toast("Region name is required"); return; }
    if (!nodeName.trim() || !nodeHost.trim()) {
      toast("At least one node with name and hostname is required");
      return;
    }
    const node: DerpNode = { name: nodeName.trim(), hostname: nodeHost.trim() };
    if (stunPort) node.stunPort = parseInt(stunPort);
    if (derpPort) node.derpPort = parseInt(derpPort);

    onAdd({
      regionId: id,
      regionCode: regionCode.trim(),
      regionName: regionName.trim(),
      nodes: [node],
    });

    setRegionId("");
    setRegionCode("");
    setRegionName("");
    setNodeName("");
    setNodeHost("");
    setStunPort("");
    setDerpPort("");
  };

  return (
    <form className="form-section form-stack" onSubmit={handleSubmit} aria-labelledby="add-region-heading">
      <h4 id="add-region-heading">Add a region</h4>
      <div className="field-row">
        <div className="field">
          <label htmlFor="region-id">Region ID (900–999)</label>
          <input id="region-id" type="text" inputMode="numeric" value={regionId} onChange={(e) => setRegionId(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="region-code">Region code</label>
          <input id="region-code" type="text" placeholder="e.g. mycolo" value={regionCode} onChange={(e) => setRegionCode(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="region-name">Region name</label>
          <input id="region-name" type="text" value={regionName} onChange={(e) => setRegionName(e.target.value)} />
        </div>
      </div>
      <fieldset className="field">
        <legend>First node (a region needs at least one)</legend>
        <div className="field-row">
          <div className="field">
            <label htmlFor="region-node-name">Node name</label>
            <input id="region-node-name" type="text" value={nodeName} onChange={(e) => setNodeName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="region-node-host">Hostname</label>
            <input id="region-node-host" type="text" className="mono" spellCheck={false} value={nodeHost} onChange={(e) => setNodeHost(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="region-stun">STUN port (optional)</label>
            <input id="region-stun" type="text" inputMode="numeric" value={stunPort} onChange={(e) => setStunPort(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="region-derp">DERP port (optional)</label>
            <input id="region-derp" type="text" inputMode="numeric" value={derpPort} onChange={(e) => setDerpPort(e.target.value)} />
          </div>
        </div>
      </fieldset>
      <button type="submit" className="btn-ghost">Add region</button>
    </form>
  );
}
