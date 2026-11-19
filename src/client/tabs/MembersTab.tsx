import { useCallback, useEffect, useState } from "react";
import { useApp } from "../hooks/useAppState";
import { useToast } from "../components/Toast";
import { useTenantMutation } from "../hooks/useMutation";
import { Card } from "../components/Card";
import { Badge } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
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
    if (!confirm(`Remove member @${handle}? This cannot be undone.`)) return;
    await mutate(
      `/members/${memberId}`,
      { method: "DELETE" },
      { successMsg: "Member removed", reload: reloadAfterMutate },
    );
  };

  if (loading) return <div className="loading">Loading...</div>;

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
        <ul className="member-list">
          {members.map((member) => {
            const avatar = safeUrl(member.avatarUrl);
            const isLocked = lockInfo.get(member.id) ?? member.isLocked ?? false;

            return (
              <li key={member.id} className="member-row">
                <div className="member-identity">
                  {avatar ? (
                    <img className="avatar" src={avatar} alt="" />
                  ) : (
                    <div className="avatar avatar-placeholder" />
                  )}
                  <div className="member-names">
                    <span className="member-display-name">
                      {member.displayName || member.handle}
                    </span>
                    <span className="member-handle">@{member.handle}</span>
                  </div>
                </div>

                <div className="member-badges">
                  {member.isOriginator ? (
                    <Badge variant="originator">originator</Badge>
                  ) : (
                    <Badge variant="role">{member.roleName || "citizen"}</Badge>
                  )}
                  {isLocked && <Badge variant="warning">locked</Badge>}
                </div>

                <div className="member-actions">
                  {hasPerm("manage_roles") && !member.isOriginator && (
                    <select
                      className="role-select"
                      value={member.roleId ?? ""}
                      onChange={(e) => handleRoleChange(member.id, e.target.value)}
                    >
                      {assignableRoles.map((role) => (
                        <option key={role.id} value={role.id}>
                          {role.name}
                        </option>
                      ))}
                    </select>
                  )}

                  {hasPerm("lock_devices") && !member.isOriginator && (
                    <button
                      className={`btn-sm ${isLocked ? "btn-warning" : "btn-ghost"}`}
                      disabled={busy}
                      onClick={() => handleToggleLock(member.id, isLocked)}
                    >
                      {isLocked ? "Unlock" : "Lock"}
                    </button>
                  )}

                  {hasPerm("kick") && !member.isOriginator && (
                    <button
                      className="btn-sm btn-danger"
                      disabled={busy}
                      onClick={() => handleRemove(member.id, member.handle)}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
