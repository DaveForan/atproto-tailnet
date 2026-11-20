import { useCallback, useEffect, useState } from "react";
import { useApp } from "../hooks/useAppState";
import { useToast } from "../components/Toast";
import { useTenantMutation } from "../hooks/useMutation";
import { Card } from "../components/Card";
import { Badge } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { Loading } from "../components/Loading";
import { useConfirm } from "../components/ConfirmDialog";
import { safeUrl } from "../lib/utils";
import { deviceService } from "../services/devices";
import type { Member } from "../lib/types";

export function MembersTab() {
  const { currentTenant, hasPerm, roles, reload } = useApp();
  const { toastError } = useToast();
  const [members, setMembers] = useState<Member[]>([]);
  const [lockInfo, setLockInfo] = useState<Map<string, boolean>>(new Map());
  const [loading, setLoading] = useState(true);

  const loadMembers = useCallback(async (showSpinner = true) => {
    if (!currentTenant) return;
    if (showSpinner) setLoading(true);
    try {
      const memberList =
        (await deviceService.getMembers(currentTenant.id)) ?? [];
      setMembers(memberList);

      if (hasPerm("lock_devices") && memberList.length > 0) {
        const lockResults = await Promise.all(
          memberList.map((m) =>
            deviceService.getDeviceLock(currentTenant.id, m.id).then((res) => ({
              memberId: m.id,
              locked: res?.locked ?? false,
            })),
          ),
        );
        const locks = new Map<string, boolean>();
        for (const r of lockResults) {
          locks.set(r.memberId, r.locked);
        }
        setLockInfo(locks);
      }
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Failed to load members");
    } finally {
      setLoading(false);
    }
  }, [currentTenant?.id]);

  useEffect(() => { loadMembers(); }, [loadMembers]);

  const { mutate, busy } = useTenantMutation();
  const confirm = useConfirm();

  const reloadAfterMutate = async () => { await loadMembers(false); reload(); };

  const handleRoleChange = async (memberId: string, roleId: string) => {
    await mutate(
      `/members/${memberId}/role`,
      { method: "PUT", body: JSON.stringify({ roleId }) },
      { successMsg: "Role updated", reload: reloadAfterMutate },
    );
  };

  const handleToggleLock = async (memberId: string, currentlyLocked: boolean) => {
    await mutate(
      "/device-locks",
      { method: currentlyLocked ? "DELETE" : "POST", body: JSON.stringify({ userId: memberId }) },
      { successMsg: currentlyLocked ? "Devices unlocked" : "Devices locked", reload: () => loadMembers(false) },
    );
  };

  const handleRemove = async (memberId: string, handle: string) => {
    if (!(await confirm({
      title: `Remove member @${handle}?`,
      message: "This also removes all of their devices and revokes their outstanding auth keys. This cannot be undone.",
      confirmLabel: "Remove member",
      danger: true,
    }))) return;
    await mutate(
      `/members/${memberId}`,
      { method: "DELETE" },
      { successMsg: "Member removed, devices deleted and keys revoked", reload: reloadAfterMutate },
    );
  };

  if (loading) return <Loading />;

  if (members.length === 0) {
    return (
      <div className="tab-content">
        <Card title="Members">
          <EmptyState>No members yet. Send an invitation to get started.</EmptyState>
        </Card>
      </div>
    );
  }

  const assignableRoles = roles.filter((r) => !r.isSystem || r.name !== "originator");

  return (
    <div className="tab-content">
      <Card title="Members">
        <ul className="item-list">
          {members.map((member) => {
            const avatar = safeUrl(member.avatarUrl);
            const isLocked = lockInfo.get(member.id) ?? member.isLocked ?? false;
            const canAct = !member.isOriginator;

            return (
              <li key={member.id} className="item-row item-row-wrap">
                <div className="item-lead">
                  {avatar ? (
                    <img className="avatar" src={avatar} alt="" />
                  ) : (
                    <div className="avatar avatar-placeholder" aria-hidden="true" />
                  )}
                  <div className="item-info">
                    <span className="item-header">
                      <span className="item-name">{member.displayName || member.handle}</span>
                      {member.isOriginator ? (
                        <Badge variant="originator">originator</Badge>
                      ) : (
                        <Badge variant="role">{member.roleName || "citizen"}</Badge>
                      )}
                      {isLocked && <Badge variant="warning">locked</Badge>}
                    </span>
                    <span className="item-detail">@{member.handle}</span>
                  </div>
                </div>

                {canAct && (hasPerm("manage_roles") || hasPerm("lock_devices") || hasPerm("kick")) && (
                  <div className="item-actions">
                    {hasPerm("manage_roles") && (
                      <select
                        className="select-compact"
                        aria-label={`Role of @${member.handle}`}
                        value={member.roleId ?? ""}
                        disabled={busy}
                        onChange={(e) => handleRoleChange(member.id, e.target.value)}
                      >
                        {assignableRoles.map((role) => (
                          <option key={role.id} value={role.id}>
                            {role.name}
                          </option>
                        ))}
                      </select>
                    )}

                    {hasPerm("lock_devices") && (
                      <button
                        type="button"
                        className={`btn-sm ${isLocked ? "btn-warning" : "btn-ghost"}`}
                        disabled={busy}
                        aria-label={`${isLocked ? "Unlock" : "Lock"} devices of @${member.handle}`}
                        onClick={() => handleToggleLock(member.id, isLocked)}
                      >
                        {isLocked ? "Unlock" : "Lock"}
                      </button>
                    )}

                    {hasPerm("kick") && (
                      <button
                        type="button"
                        className="btn-sm btn-danger"
                        disabled={busy}
                        aria-label={`Remove member @${member.handle}`}
                        onClick={() => handleRemove(member.id, member.handle)}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
