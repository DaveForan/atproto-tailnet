import { useState } from "react";
import { aclService } from "../services/acl";
import { useSession } from "../hooks/session";
import { useTenantData } from "../hooks/useTenantData";
import { useTenantMutation } from "../hooks/useMutation";
import { Loading } from "../components/Loading";
import { LoadError } from "../components/LoadError";
import { useConfirm } from "../components/ConfirmDialog";
import type { AclGetResponse } from "../lib/types";
import { useAclDraft } from "./acl/useAclDraft";
import { RulesCard } from "./acl/RulesCard";
import { HostsCard } from "./acl/HostsCard";

export function AclTab() {
  const { hasPerm } = useSession();
  const { mutate, busy } = useTenantMutation({ onError: "Failed to save ACL policy" });
  const confirm = useConfirm();
  const canManage = hasPerm("manage_acl");
  const { data, loading, error, reload } = useTenantData<AclGetResponse | null>(
    (tid) => aclService.getAcl(tid),
    null,
    [],
    { keepPreviousOnReload: true },
  );
  const { draft, load, ...edit } = useAclDraft();

  // Each loaded policy replaces the draft once
  const [loaded, setLoaded] = useState<AclGetResponse | null>(null);
  if (data && data !== loaded) {
    setLoaded(data);
    load({ acls: data.policy.acls ?? [], hosts: data.policy.hosts ?? {} });
  }

  const sourceOptions = [...Object.keys(draft.hosts), "*"];

  const handleSave = async () => {
    await mutate(
      (tid) => aclService.setAcl(tid, draft),
      { successMsg: "ACL policy saved" },
    );
  };

  const handleReset = async () => {
    if (!(await confirm({
      title: "Reset the ACL to allow-all?",
      message: "This removes all existing rules and hosts. Nothing changes on the tailnet until you save.",
      confirmLabel: "Reset",
      danger: true,
    }))) return;
    edit.resetToAllowAll();
  };

  if (loading) return <Loading />;

  return (
    <div className="tab-content">
      <LoadError error={error} onRetry={reload} />
      <p className="notice mb-12" role="note">
        Rules work between hosts, IPs/CIDRs and <code>*</code>. Users, groups, tags and auto-approvers are not
        supported; policies using them are rejected on save.
      </p>

      <RulesCard
        acls={draft.acls}
        sourceOptions={sourceOptions}
        canManage={canManage}
        onAdd={edit.addRule}
        onRemove={edit.removeRule}
      />
      <HostsCard hosts={draft.hosts} canManage={canManage} onAdd={edit.addHost} onRemove={edit.removeHost} />

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
