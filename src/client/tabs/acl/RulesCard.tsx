import { useState } from "react";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import type { AclRule } from "../../lib/types";
import { ChipPicker } from "./ChipPicker";

export function RulesCard({
  acls,
  sourceOptions,
  canManage,
  onAdd,
  onRemove,
}: {
  acls: AclRule[];
  sourceOptions: string[];
  canManage: boolean;
  onAdd: (rule: AclRule) => void;
  onRemove: (index: number) => void;
}) {
  const [src, setSrc] = useState<string[]>([]);
  const [dst, setDst] = useState<string[]>([]);
  const [port, setPort] = useState("");

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    if (src.length === 0 || dst.length === 0) return;
    onAdd({ action: "accept", src, dst: dst.map((d) => `${d}:${port || "*"}`) });
    setSrc([]);
    setDst([]);
    setPort("");
  };

  return (
    <Card title="Rules">
      {acls.length === 0 ? (
        <EmptyState>No ACL rules defined.</EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="data-table stack">
            <caption className="sr-only">ACL rules</caption>
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Destination</th>
                <th scope="col">Action</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {acls.map((rule, i) => (
                <tr key={i}>
                  <td data-label="Source" className="mono">{rule.src.join(", ")}</td>
                  <td data-label="Destination" className="mono">{rule.dst.join(", ")}</td>
                  <td data-label="Action">{rule.action}</td>
                  <td className="cell-actions">
                    <button
                      type="button"
                      className="btn-sm btn-ghost"
                      aria-label={`Remove rule ${i + 1}`}
                      onClick={() => onRemove(i)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form className="form-section form-stack" onSubmit={add} aria-labelledby="acl-add-rule">
        <h4 id="acl-add-rule">Add a rule</h4>
        <ChipPicker label="Source" options={sourceOptions} selected={src} onChange={setSrc} empty="No sources available." />
        <ChipPicker label="Destination" options={sourceOptions} selected={dst} onChange={setDst} empty="No destinations available." />
        <div className="field">
          <label htmlFor="acl-rule-port">Port (optional)</label>
          <div className="inline-form">
            <input
              id="acl-rule-port"
              type="text"
              placeholder="e.g. 443"
              value={port}
              onChange={(e) => setPort(e.target.value)}
            />
            <button type="submit" className="btn-ghost" disabled={!canManage || src.length === 0 || dst.length === 0}>
              Add rule
            </button>
          </div>
        </div>
      </form>
    </Card>
  );
}
