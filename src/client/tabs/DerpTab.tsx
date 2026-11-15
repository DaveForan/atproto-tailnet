import { useCallback, useEffect, useState } from "react";
import { networkService } from "../services/network";
import { useApp } from "../hooks/useAppState";
import { useToast } from "../components/Toast";
import { useTenantMutation } from "../hooks/useMutation";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
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

  const load = useCallback(async () => {
    if (!currentTenant) return;
    try {
      const data = await networkService.getDerp(currentTenant.id);
      if (data) setConfig(data);
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Failed to load DERP config");
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

  return (
    <div className="tab-content">
      <Card title="DERP Relay Configuration">
        <p className="help-text">
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

      <Card title="Custom DERP Regions" className="mt-12">
        {config.regions.length === 0 ? (
          <EmptyState>No custom DERP regions defined</EmptyState>
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

      <div className="mt-12">
        <button className="btn-primary" onClick={save} disabled={busy}>Save DERP Configuration</button>
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

  const handleAddNode = () => {
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
    <div className="role-card">
      <div className="role-card-header">
        <div>
          <strong>{region.regionName}</strong>
          <span className="badge badge-role ml-8">{region.regionCode}</span>
          <span className="text-dim text-sm ml-8">ID: {region.regionId}</span>
        </div>
        <button className="btn-sm btn-danger" onClick={onRemove}>
          Remove
        </button>
      </div>
      {region.nodes.map((node, nIdx) => (
        <div key={nIdx} className="approval-item text-sm">
          <div>
            <strong>{node.name}</strong>
            <span className="text-dim mono ml-8">{node.hostname}</span>
            {node.stunPort != null && (
              <span className="text-dim text-xs ml-8">
                STUN:{node.stunPort}
              </span>
            )}
            {node.derpPort != null && (
              <span className="text-dim text-xs ml-8">
                DERP:{node.derpPort}
              </span>
            )}
          </div>
          <button className="btn-sm btn-danger" onClick={() => onRemoveNode(nIdx)}>
            Del
          </button>
        </div>
      ))}
      <div className="inline-form mt-8">
        <input
          type="text"
          placeholder="Node name"
          value={nodeName}
          onChange={(e) => setNodeName(e.target.value)}
          className="w-140"
        />
        <input
          type="text"
          placeholder="Hostname"
          value={nodeHost}
          onChange={(e) => setNodeHost(e.target.value)}
        />
        <input
          type="text"
          placeholder="STUN port"
          value={stunPort}
          onChange={(e) => setStunPort(e.target.value)}
          className="w-100"
        />
        <input
          type="text"
          placeholder="DERP port"
          value={derpPort}
          onChange={(e) => setDerpPort(e.target.value)}
          className="w-100"
        />
        <button className="btn-sm btn-primary" onClick={handleAddNode}>
          Add Node
        </button>
      </div>
    </div>
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

  const handleSubmit = () => {
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
    <div className="form-section">
      <h4>Add Region</h4>
      <div className="form-stack">
        <div className="inline-form">
          <input type="text" placeholder="Region ID (900-999)" value={regionId} onChange={(e) => setRegionId(e.target.value)} className="w-180" />
          <input type="text" placeholder="Region code (e.g. mycolo)" value={regionCode} onChange={(e) => setRegionCode(e.target.value)} className="w-180" />
          <input type="text" placeholder="Region name" value={regionName} onChange={(e) => setRegionName(e.target.value)} />
        </div>
        <div className="help-text">Initial node (at least one required):</div>
        <div className="inline-form">
          <input type="text" placeholder="Node name" value={nodeName} onChange={(e) => setNodeName(e.target.value)} className="w-160" />
          <input type="text" placeholder="Hostname" value={nodeHost} onChange={(e) => setNodeHost(e.target.value)} />
        </div>
        <div className="inline-form">
          <input type="text" placeholder="STUN port (optional)" value={stunPort} onChange={(e) => setStunPort(e.target.value)} className="w-180" />
          <input type="text" placeholder="DERP port (optional)" value={derpPort} onChange={(e) => setDerpPort(e.target.value)} className="w-180" />
          <button className="btn-primary" onClick={handleSubmit}>Add Region</button>
        </div>
      </div>
    </div>
  );
}
