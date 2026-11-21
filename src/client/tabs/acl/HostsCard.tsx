import { useState } from "react";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";

export function HostsCard({
  hosts,
  canManage,
  onAdd,
  onRemove,
}: {
  hosts: Record<string, string>;
  canManage: boolean;
  onAdd: (name: string, ip: string) => void;
  onRemove: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [ip, setIp] = useState("");

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    const addr = ip.trim();
    if (!n || !addr) return;
    onAdd(n, addr);
    setName("");
    setIp("");
  };

  return (
    <Card title="Hosts">
      {Object.keys(hosts).length === 0 ? (
        <EmptyState>No hosts defined.</EmptyState>
      ) : (
        <ul className="item-list">
          {Object.entries(hosts).map(([host, addr]) => (
            <li key={host} className="item-row">
              <div className="item-info">
                <span className="item-name">{host}</span>
                <span className="item-detail mono">{addr}</span>
              </div>
              <button
                type="button"
                className="btn-sm btn-ghost"
                aria-label={`Remove host ${host}`}
                onClick={() => onRemove(host)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="form-section form-stack" onSubmit={add} aria-labelledby="acl-add-host">
        <h4 id="acl-add-host">Add a host</h4>
        <div className="field-row">
          <div className="field">
            <label htmlFor="acl-host-name">Host name</label>
            <input id="acl-host-name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="acl-host-ip">IP address or CIDR</label>
            <input
              id="acl-host-ip"
              type="text"
              className="mono"
              spellCheck={false}
              value={ip}
              onChange={(e) => setIp(e.target.value)}
            />
          </div>
        </div>
        <button type="submit" className="btn-ghost" disabled={!canManage || !name.trim() || !ip.trim()}>
          Add host
        </button>
      </form>
    </Card>
  );
}
