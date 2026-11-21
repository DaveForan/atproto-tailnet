import { useState } from "react";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { ChipPicker } from "./ChipPicker";

export function GroupsCard({
  groups,
  users,
  canManage,
  onAdd,
  onRemove,
}: {
  groups: Record<string, string[]>;
  users: string[];
  canManage: boolean;
  onAdd: (name: string, members: string[]) => void;
  onRemove: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [members, setMembers] = useState<string[]>([]);

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || members.length === 0) return;
    onAdd(trimmed, members);
    setName("");
    setMembers([]);
  };

  return (
    <Card title="Groups">
      {Object.keys(groups).length === 0 ? (
        <EmptyState>No groups defined.</EmptyState>
      ) : (
        <ul className="item-list">
          {Object.entries(groups).map(([group, list]) => (
            <li key={group} className="item-row">
              <div className="item-info">
                <span className="item-name">{group}</span>
                <span className="item-detail">{list.join(", ")}</span>
              </div>
              <button
                type="button"
                className="btn-sm btn-ghost"
                aria-label={`Remove group ${group}`}
                onClick={() => onRemove(group)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="form-section form-stack" onSubmit={add} aria-labelledby="acl-add-group">
        <h4 id="acl-add-group">Add a group</h4>
        <div className="field">
          <label htmlFor="acl-group-name">Group name</label>
          <input id="acl-group-name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <ChipPicker label="Members" options={users} selected={members} onChange={setMembers} empty="No users on this tailnet yet." />
        <button type="submit" className="btn-ghost" disabled={!canManage || !name.trim() || members.length === 0}>
          Add group
        </button>
      </form>
    </Card>
  );
}
