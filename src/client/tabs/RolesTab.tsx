import { useEffect, useState } from "react";
import { useSession } from "../hooks/session";
import { rolesService } from "../services/roles";
import { useTenantMutation } from "../hooks/useMutation";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { Badge } from "../components/Badge";
import { useConfirm } from "../components/ConfirmDialog";

export function RolesTab() {
  const { currentTenant, roles, allPerms, reloadRoles, hasPerm } = useSession();
  const { mutate, busy } = useTenantMutation({
    onError: "Role operation failed",
    reload: reloadRoles,
  });
  const [newRoleName, setNewRoleName] = useState("");
  const [defaultRoleId, setDefaultRoleId] = useState(
    () => roles.find((r) => r.isDefault)?.id ?? "",
  );
  const canManage = hasPerm("manage_roles");
  const confirm = useConfirm();

  useEffect(() => {
    setDefaultRoleId(roles.find((r) => r.isDefault)?.id ?? "");
  }, [roles]);

  const handleTogglePerm = async (roleId: string, perm: string) => {
    if (!currentTenant) return;
    const role = roles.find((r) => r.id === roleId);
    if (!role || role.isSystem) return;
    const has = role.permissions.includes(perm);
    const permissions = has
      ? role.permissions.filter((p) => p !== perm)
      : [...role.permissions, perm];
    await mutate(
      (tid) => rolesService.updateRole(tid, roleId, permissions),
      { successMsg: "Role updated" },
    );
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentTenant || !newRoleName.trim()) return;
    const ok = await mutate(
      (tid) => rolesService.createRole(tid, newRoleName.trim(), []),
      { successMsg: "Role created" },
    );
    if (ok) setNewRoleName("");
  };

  const handleDelete = async (roleId: string, roleName: string) => {
    if (!currentTenant) return;
    if (!(await confirm({ title: `Delete role "${roleName}"?`, message: "This cannot be undone.", confirmLabel: "Delete role", danger: true }))) return;
    await mutate(
      (tid) => rolesService.deleteRole(tid, roleId),
      { successMsg: "Role deleted" },
    );
  };

  const handleSetDefault = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentTenant || !defaultRoleId) return;
    await mutate(
      (tid) => rolesService.setDefaultRole(tid, defaultRoleId),
      { successMsg: "Default role updated" },
    );
  };

  return (
    <div className="tab-content">
      <Card title="Create a role">
        <form className="field" onSubmit={handleCreate}>
          <label htmlFor="new-role-name">Role name</label>
          <div className="inline-form">
            <input
              id="new-role-name"
              type="text"
              value={newRoleName}
              disabled={!canManage}
              onChange={(e) => setNewRoleName(e.target.value)}
            />
            <button type="submit" disabled={busy || !canManage || !newRoleName.trim()}>
              Create
            </button>
          </div>
          <p className="help-text">A new role starts with no permissions. Turn them on below.</p>
        </form>
      </Card>

      <Card title="Default role">
        <form className="field" onSubmit={handleSetDefault}>
          <label htmlFor="default-role">Role given to new members</label>
          <div className="inline-form">
            <select
              id="default-role"
              value={defaultRoleId}
              disabled={!canManage}
              onChange={(e) => setDefaultRoleId(e.target.value)}
            >
              <option value="">Select a role</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <button type="submit" disabled={busy || !canManage || !defaultRoleId}>
              Save
            </button>
          </div>
        </form>
      </Card>

      <Card title="Roles">
        {roles.length === 0 ? (
          <EmptyState>No roles defined yet.</EmptyState>
        ) : (
          roles.map((role) => {
            const locked = role.isSystem || !canManage;
            return (
              <section key={role.id} className="sub-card" aria-label={`Role ${role.name}`}>
                <div className="sub-card-header">
                  <h4>
                    {role.name}
                    {role.isSystem && <Badge variant="role">system</Badge>}
                    {role.isDefault && <Badge variant="running">default</Badge>}
                  </h4>
                  {!role.isSystem && canManage && (
                    <button
                      type="button"
                      className="btn-sm btn-danger"
                      aria-label={`Delete role ${role.name}`}
                      onClick={() => handleDelete(role.id, role.name)}
                      disabled={busy}
                    >
                      Delete
                    </button>
                  )}
                </div>
                <div className="chip-list" role="group" aria-label={`Permissions of ${role.name}`}>
                  {allPerms.map((perm) => (
                    <button
                      key={perm}
                      type="button"
                      className="chip"
                      aria-pressed={role.permissions.includes(perm)}
                      onClick={() => handleTogglePerm(role.id, perm)}
                      disabled={locked || busy}
                    >
                      {perm}
                    </button>
                  ))}
                </div>
                {role.isSystem && <p className="help-text mt-8">System roles can&apos;t be edited here.</p>}
              </section>
            );
          })
        )}
      </Card>
    </div>
  );
}
