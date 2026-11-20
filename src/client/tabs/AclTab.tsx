import { useCallback, useEffect, useState } from "react";
import { aclService } from "../services/acl";
import { useSession } from "../hooks/session";
import { useToast } from "../components/Toast";
import { useTenantMutation } from "../hooks/useMutation";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { Loading } from "../components/Loading";
import { useConfirm } from "../components/ConfirmDialog";
import type { AclRule } from "../lib/types";
import { LoadError } from "../components/LoadError";
import { errorMessage } from "../lib/utils";

export function AclTab() {
  const { currentTenant, hasPerm } = useSession();
  const { toast } = useToast();
  const { mutate, busy } = useTenantMutation({ onError: "Failed to save ACL policy" });
  const coordinatorMode = !!currentTenant?.coordinatorTenantId;
  const [users, setUsers] = useState<string[]>([]);
  const [acls, setAcls] = useState<AclRule[]>([]);
  const [groups, setGroups] = useState<Record<string, string[]>>({});
  const [hosts, setHosts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const confirm = useConfirm();
  const canManage = hasPerm("manage_acl");

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
      setLoadError(null);
      if (data) {
        setAcls(data.policy.acls ?? []);
        setGroups(data.policy.groups ?? {});
        setHosts(data.policy.hosts ?? {});
        setUsers(data.users ?? []);
      }
    } catch (e) {
      setLoadError(errorMessage(e, "Failed to load ACL policy"));
    } finally {
      setLoading(false);
    }
  }, [currentTenant?.id]);

  useEffect(() => { loadAcl(); }, [loadAcl]);

  const sourceOptions = coordinatorMode
    ? [...Object.keys(hosts), "*"]
    : [...users, ...Object.keys(groups).map((g) => `group:${g}`), "*"];

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

  const addRule = (e: React.FormEvent) => {
    e.preventDefault();
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

  const addGroup = (e: React.FormEvent) => {
    e.preventDefault();
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

  const addHost = (e: React.FormEvent) => {
    e.preventDefault();
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
    await mutate(
      (tid) => aclService.setAcl(tid, { acls, groups, hosts }, coordinatorMode),
      { successMsg: "ACL policy saved" },
    );
  };

  const handleReset = async () => {
    if (!(await confirm({
      title: "Reset the ACL to allow-all?",
      message: "This removes all existing rules, groups and hosts. Nothing changes on the tailnet until you save.",
      confirmLabel: "Reset",
      danger: true,
    }))) return;
    setAcls([{ action: "accept", src: ["*"], dst: ["*:*"] }]);
    setGroups({});
    setHosts({});
    toast("ACL reset to allow-all (unsaved)");
  };

  if (loading) return <Loading />;

  const chips = (
    label: string,
    options: string[],
    selected: string[],
    setter: React.Dispatch<React.SetStateAction<string[]>>,
    empty: string,
  ) => (
    <fieldset className="field">
      <legend>{label}</legend>
      {options.length === 0 ? (
        <p className="help-text">{empty}</p>
      ) : (
        <div className="chip-list">
          {options.map((opt) => (
            <button
              key={opt}
              type="button"
              className="chip"
              aria-pressed={selected.includes(opt)}
              onClick={() => toggleMulti(selected, setter, opt)}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </fieldset>
  );

  return (
    <div className="tab-content">
      <LoadError error={loadError} onRetry={loadAcl} />
      {coordinatorMode && (
        <p className="notice mb-12" role="note">
          This tailnet runs on the built-in coordinator, which supports rules between hosts,
          IPs/CIDRs and <code>*</code>. Users, groups, tags and auto-approvers are not supported
          here; policies using them are rejected on save.
        </p>
      )}

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
                        onClick={() => removeRule(i)}
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
        <form className="form-section form-stack" onSubmit={addRule} aria-labelledby="acl-add-rule">
          <h4 id="acl-add-rule">Add a rule</h4>
          {chips("Source", sourceOptions, ruleSrc, setRuleSrc, "No sources available.")}
          {chips("Destination", sourceOptions, ruleDst, setRuleDst, "No destinations available.")}
          <div className="field">
            <label htmlFor="acl-rule-port">Port (optional)</label>
            <div className="inline-form">
              <input
                id="acl-rule-port"
                type="text"
                placeholder="e.g. 443"
                value={rulePort}
                onChange={(e) => setRulePort(e.target.value)}
              />
              <button type="submit" className="btn-ghost" disabled={!canManage || ruleSrc.length === 0 || ruleDst.length === 0}>
                Add rule
              </button>
            </div>
          </div>
        </form>
      </Card>

      {!coordinatorMode && <Card title="Groups">
        {Object.keys(groups).length === 0 ? (
          <EmptyState>No groups defined.</EmptyState>
        ) : (
          <ul className="item-list">
            {Object.entries(groups).map(([name, members]) => (
              <li key={name} className="item-row">
                <div className="item-info">
                  <span className="item-name">{name}</span>
                  <span className="item-detail">{members.join(", ")}</span>
                </div>
                <button
                  type="button"
                  className="btn-sm btn-ghost"
                  aria-label={`Remove group ${name}`}
                  onClick={() => removeGroup(name)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <form className="form-section form-stack" onSubmit={addGroup} aria-labelledby="acl-add-group">
          <h4 id="acl-add-group">Add a group</h4>
          <div className="field">
            <label htmlFor="acl-group-name">Group name</label>
            <input
              id="acl-group-name"
              type="text"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
            />
          </div>
          {chips("Members", users, groupMembers, setGroupMembers, "No users on this tailnet yet.")}
          <button type="submit" className="btn-ghost" disabled={!canManage || !groupName.trim() || groupMembers.length === 0}>
            Add group
          </button>
        </form>
      </Card>}

      <Card title="Hosts">
        {Object.keys(hosts).length === 0 ? (
          <EmptyState>No hosts defined.</EmptyState>
        ) : (
          <ul className="item-list">
            {Object.entries(hosts).map(([name, ip]) => (
              <li key={name} className="item-row">
                <div className="item-info">
                  <span className="item-name">{name}</span>
                  <span className="item-detail mono">{ip}</span>
                </div>
                <button
                  type="button"
                  className="btn-sm btn-ghost"
                  aria-label={`Remove host ${name}`}
                  onClick={() => removeHost(name)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <form className="form-section form-stack" onSubmit={addHost} aria-labelledby="acl-add-host">
          <h4 id="acl-add-host">Add a host</h4>
          <div className="field-row">
            <div className="field">
              <label htmlFor="acl-host-name">Host name</label>
              <input
                id="acl-host-name"
                type="text"
                value={hostName}
                onChange={(e) => setHostName(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="acl-host-ip">IP address or CIDR</label>
              <input
                id="acl-host-ip"
                type="text"
                className="mono"
                spellCheck={false}
                value={hostIp}
                onChange={(e) => setHostIp(e.target.value)}
              />
            </div>
          </div>
          <button type="submit" className="btn-ghost" disabled={!canManage || !hostName.trim() || !hostIp.trim()}>
            Add host
          </button>
        </form>
      </Card>

      <div className="form-footer btn-group">
        <button type="button" onClick={handleSave} disabled={busy || !canManage}>
          {busy ? "Saving…" : "Save policy"}
        </button>
        <span className="text-dim text-sm">Added and removed rules apply when you save.</span>
        <button type="button" className="btn-sm btn-danger btn-apart" onClick={() => { void handleReset(); }} disabled={!canManage}>
          Reset to allow-all
        </button>
      </div>
    </div>
  );
}
