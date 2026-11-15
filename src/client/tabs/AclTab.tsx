import { useCallback, useEffect, useState } from "react";
import { aclService } from "../services/acl";
import { useApp } from "../hooks/useAppState";
import { useToast } from "../components/Toast";
import { useTenantMutation } from "../hooks/useMutation";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import type { AclGetResponse, AclRule } from "../lib/types";

export function AclTab() {
  const { currentTenant, hasPerm } = useApp();
  const { toast, toastError } = useToast();
  const { mutate, busy } = useTenantMutation();
  const [users, setUsers] = useState<string[]>([]);
  const [acls, setAcls] = useState<AclRule[]>([]);
  const [groups, setGroups] = useState<Record<string, string[]>>({});
  const [hosts, setHosts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  // Add rule form
  const [ruleSrc, setRuleSrc] = useState<string[]>([]);
  const [ruleDst, setRuleDst] = useState<string[]>([]);
  const [rulePort, setRulePort] = useState("");

  // Add group form
  const [groupName, setGroupName] = useState("");
  const [groupMembers, setGroupMembers] = useState<string[]>([]);

  // Add host form
  const [hostName, setHostName] = useState("");
  const [hostIp, setHostIp] = useState("");

  const loadAcl = useCallback(async () => {
    if (!currentTenant) return;
    try {
      const data = await aclService.getAcl(currentTenant.id);
      if (data) {
        setAcls(data.policy.acls ?? []);
        setGroups(data.policy.groups ?? {});
        setHosts(data.policy.hosts ?? {});
        setUsers(data.users ?? []);
      }
    } catch (e) {
      toastError(
        e instanceof Error ? e.message : "Failed to load ACL policy",
      );
    } finally {
      setLoading(false);
    }
  }, [currentTenant?.id]);

  useEffect(() => { loadAcl(); }, [loadAcl]);

  const sourceOptions = [
    ...users,
    ...Object.keys(groups).map((g) => `group:${g}`),
    "*",
  ];

  const toggleMulti = (
    current: string[],
    setter: React.Dispatch<React.SetStateAction<string[]>>,
    value: string,
  ) => {
    setter(
      current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value],
    );
  };

  const addRule = () => {
    if (ruleSrc.length === 0 || ruleDst.length === 0) return;
    const dst = ruleDst.map((d) =>
      rulePort ? `${d}:${rulePort}` : `${d}:*`,
    );
    setAcls([...acls, { action: "accept", src: ruleSrc, dst }]);
    setRuleSrc([]);
    setRuleDst([]);
    setRulePort("");
    toast("Rule added (unsaved)");
  };

  const removeRule = (index: number) => {
    setAcls(acls.filter((_, i) => i !== index));
    toast("Rule removed (unsaved)");
  };

  const addGroup = () => {
    const name = groupName.trim();
    if (!name || groupMembers.length === 0) return;
    setGroups({ ...groups, [name]: groupMembers });
    setGroupName("");
    setGroupMembers([]);
    toast("Group added (unsaved)");
  };

  const removeGroup = (name: string) => {
    const next = { ...groups };
    delete next[name];
    setGroups(next);
    toast("Group removed (unsaved)");
  };

  const addHost = () => {
    const n = hostName.trim();
    const ip = hostIp.trim();
    if (!n || !ip) return;
    setHosts({ ...hosts, [n]: ip });
    setHostName("");
    setHostIp("");
    toast("Host added (unsaved)");
  };

  const removeHost = (name: string) => {
    const next = { ...hosts };
    delete next[name];
    setHosts(next);
    toast("Host removed (unsaved)");
  };

  const handleSave = async () => {
    await mutate("/acl", {
      method: "PUT",
      body: JSON.stringify({ acls, groups, hosts }),
    }, { successMsg: "ACL policy saved" });
  };

  const handleReset = () => {
    if (!confirm("Reset ACL to allow-all? This removes all existing rules.")) return;
    setAcls([{ action: "accept", src: ["*"], dst: ["*:*"] }]);
    setGroups({});
    setHosts({});
    toast("ACL reset to allow-all (unsaved)");
  };

  if (loading) return <div className="loading">Loading...</div>;

  return (
    <div className="tab-content">
      <div className="form-row">
        <button className="btn-primary" onClick={handleSave} disabled={busy || !hasPerm("manage_acl")}>
          Save Policy
        </button>
        <button className="btn-sm btn-danger" onClick={handleReset} disabled={!hasPerm("manage_acl")}>
          Reset to Allow-All
        </button>
      </div>

      <Card title="Rules">
        {acls.length === 0 ? (
          <EmptyState>No ACL rules defined.</EmptyState>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Destination</th>
                <th>Action</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {acls.map((rule, i) => (
                <tr key={i}>
                  <td>{rule.src.join(", ")}</td>
                  <td>{rule.dst.join(", ")}</td>
                  <td>{rule.action}</td>
                  <td>
                    <button
                      className="btn-sm btn-danger"
                      onClick={() => removeRule(i)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="form-stack">
          <div className="form-field">
            <label>Source:</label>
            <div className="chip-list">
              {sourceOptions.map((opt) => (
                <button
                  key={opt}
                  className={`chip ${ruleSrc.includes(opt) ? "chip-active" : ""}`}
                  onClick={() => toggleMulti(ruleSrc, setRuleSrc, opt)}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>
          <div className="form-field">
            <label>Destination:</label>
            <div className="chip-list">
              {sourceOptions.map((opt) => (
                <button
                  key={opt}
                  className={`chip ${ruleDst.includes(opt) ? "chip-active" : ""}`}
                  onClick={() => toggleMulti(ruleDst, setRuleDst, opt)}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>
          <div className="form-row">
            <input
              type="text"
              placeholder="Port (optional, e.g. 443)"
              value={rulePort}
              onChange={(e) => setRulePort(e.target.value)}
            />
            <button className="btn-primary" onClick={addRule} disabled={!hasPerm("manage_acl")}>
              Add Rule
            </button>
          </div>
        </div>
      </Card>

      <Card title="Groups">
        {Object.keys(groups).length === 0 ? (
          <EmptyState>No groups defined.</EmptyState>
        ) : (
          <ul className="item-list">
            {Object.entries(groups).map(([name, members]) => (
              <li key={name} className="item-row">
                <div className="item-info">
                  <span className="item-name">{name}</span>
                  <span className="item-meta">{members.join(", ")}</span>
                </div>
                <button
                  className="btn-sm btn-danger"
                  onClick={() => removeGroup(name)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="form-stack">
          <input
            type="text"
            placeholder="Group name"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
          />
          <div className="form-field">
            <label>Members:</label>
            <div className="chip-list">
              {users.map((u) => (
                <button
                  key={u}
                  className={`chip ${groupMembers.includes(u) ? "chip-active" : ""}`}
                  onClick={() =>
                    toggleMulti(groupMembers, setGroupMembers, u)
                  }
                >
                  {u}
                </button>
              ))}
            </div>
          </div>
          <button className="btn-primary" onClick={addGroup} disabled={!hasPerm("manage_acl")}>
            Add Group
          </button>
        </div>
      </Card>

      <Card title="Hosts">
        {Object.keys(hosts).length === 0 ? (
          <EmptyState>No hosts defined.</EmptyState>
        ) : (
          <ul className="item-list">
            {Object.entries(hosts).map(([name, ip]) => (
              <li key={name} className="item-row">
                <div className="item-info">
                  <span className="item-name">{name}</span>
                  <span className="item-meta">{ip}</span>
                </div>
                <button
                  className="btn-sm btn-danger"
                  onClick={() => removeHost(name)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="form-row">
          <input
            type="text"
            placeholder="Host name"
            value={hostName}
            onChange={(e) => setHostName(e.target.value)}
          />
          <input
            type="text"
            placeholder="IP address"
            value={hostIp}
            onChange={(e) => setHostIp(e.target.value)}
          />
          <button className="btn-primary" onClick={addHost} disabled={!hasPerm("manage_acl")}>
            Add Host
          </button>
        </div>
      </Card>
    </div>
  );
}
