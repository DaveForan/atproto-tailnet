import { useTabRoute } from "../hooks/useTabRoute";
import { useSession } from "../hooks/session";
import { useTenantData } from "../hooks/useTenantData";
import { useTenantMutation } from "../hooks/useMutation";
import { Card } from "../components/Card";
import { Badge } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { Loading } from "../components/Loading";
import { useConfirm } from "../components/ConfirmDialog";
import { safeUrl } from "../lib/utils";
import { deviceService } from "../services/devices";
import type { Member } from "../lib/types";
import { LoadError } from "../components/LoadError";

const NO_MEMBERS: Member[] = [];

export function MembersTab() {
  const { hasPerm, roles, reloadTenants } = useSession();
  const { setTab } = useTabRoute();
  const { data: members, loading, error: loadError, reload } = useTenantData<Member[]>(
    (tid) => deviceService.getMembers(tid),
    NO_MEMBERS,
    [],
    { keepPreviousOnReload: true },
  );

  const { mutate, busy } = useTenantMutation();
  const confirm = useConfirm();

  // Roles and the member count also show outside this tab
  const reloadAfterMutate = async () => { await reload(); void reloadTenants(); };

  const handleRoleChange = async (memberId: string, roleId: string) => {
    await mutate(
      (tid) => deviceService.setMemberRole(tid, memberId, roleId),
      { successMsg: "Role updated", reload: reloadAfterMutate },
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
      (tid) => deviceService.removeMember(tid, memberId),
      { successMsg: "Member removed, devices deleted and keys revoked", reload: reloadAfterMutate },
    );
  };

  const handleInvalidate = async (memberId: string, handle: string) => {
    if (!(await confirm({
      title: `Invalidate the devices and keys of @${handle}?`,
      message: "Every device of this member loses access now and every key of theirs stops working. They stay a member and add their devices again. This cannot be undone.",
      confirmLabel: "Invalidate",
      danger: true,
    }))) return;
    await mutate(
      (tid) => deviceService.invalidateDevices(tid, memberId),
      { successMsg: "Devices removed and keys revoked", reload: reloadAfterMutate },
    );
  };

  const inviteAction = hasPerm("invite") && (
    <button type="button" className="btn-sm" onClick={() => setTab("people", "invite")}>Invite someone</button>
  );

  if (loading) return <Loading />;

  if (members.length === 0) {
    return (
      <div className="tab-content">
        <LoadError error={loadError} onRetry={reload} />
        <Card title="Members" actions={inviteAction}>
          {loadError ? (
            <p className="help-text">The member list could not be loaded.</p>
          ) : (
            <EmptyState>No members yet.</EmptyState>
          )}
        </Card>
      </div>
    );
  }

  const assignableRoles = roles.filter((r) => !r.isSystem || r.name !== "originator");

  return (
    <div className="tab-content">
      <LoadError error={loadError} onRetry={reload} />
      <Card title="Members" actions={inviteAction}>
        <ul className="item-list">
          {members.map((member) => {
            const avatar = safeUrl(member.avatarUrl);
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
                    </span>
                    <span className="item-detail">@{member.handle}</span>
                  </div>
                </div>

                {canAct && (hasPerm("manage_roles") || hasPerm("kick") || hasPerm("manage_devices")) && (
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

                    {hasPerm("manage_devices") && (
                      <button
                        type="button"
                        className="btn-sm btn-ghost"
                        disabled={busy}
                        aria-label={`Invalidate the devices and keys of @${member.handle}`}
                        onClick={() => handleInvalidate(member.id, member.handle)}
                      >
                        Invalidate devices
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
