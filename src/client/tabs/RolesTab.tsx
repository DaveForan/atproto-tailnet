import { useEffect, useState } from "react";
import { useApp } from "../hooks/useAppState";
import { useTenantMutation } from "../hooks/useMutation";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";

export function RolesTab() {
  const { currentTenant, roles, allPerms, reloadRoles, hasPerm } = useApp();
  const { mutate, busy } = useTenantMutation({
    onError: "Role operation failed",
    reload: reloadRoles,
  });
  const [newRoleName, setNewRoleName] = useState("");
  const [defaultRoleId, setDefaultRoleId] = useState(
    () => roles.find((r) => r.isDefault)?.id ?? "",
  );
  const canManage = hasPerm("manage_roles");

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
      `/roles/${roleId}`,
      { method: "PUT", body: JSON.stringify({ permissions }) },
      { successMsg: "Role updated" },
    );
  };

  const handleCreate = async () => {
    if (!currentTenant || !newRoleName.trim()) return;
    const ok = await mutate(
      "/roles",
      { method: "POST", body: JSON.stringify({ name: newRoleName.trim(), permissions: [] }) },
      { successMsg: "Role created" },
    );
    if (ok) setNewRoleName("");
  };

  const handleDelete = async (roleId: string, roleName: string) => {
    if (!currentTenant) return;
    if (!confirm(`Delete role "${roleName}"? This cannot be undone.`)) return;
    await mutate(
      `/roles/${roleId}`,
      { method: "DELETE" },
      { successMsg: "Role deleted" },
    );
  };

  const handleSetDefault = async () => {
    if (!currentTenant || !defaultRoleId) return;
    await mutate(
      "/roles/default",
      { method: "PUT", body: JSON.stringify({ roleId: defaultRoleId }) },
      { successMsg: "Default role updated" },
    );
  };

  return (
    <div className="tab-content">
      <Card title="Create Role">
        <div className="form-row">
          <input
            type="text"
            className="input"
            placeholder="Role name"
            value={newRoleName}
            onChange={(e) => setNewRoleName(e.target.value)}
          />
          <button className="btn-primary" onClick={handleCreate} disabled={busy || !canManage}>
            Create
          </button>
        </div>
      </Card>

      <Card title="Default Role">
        <div className="form-row">
          <select
            value={defaultRoleId}
            onChange={(e) => setDefaultRoleId(e.target.value)}
          >
            <option value="">-- select --</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <button className="btn-primary" onClick={handleSetDefault} disabled={busy || !canManage}>
            Save
          </button>
        </div>
      </Card>

      <Card title="Roles">
        {roles.length === 0 ? (
          <EmptyState>No roles defined yet.</EmptyState>
        ) : (
          <div className="role-list">
            {roles.map((role) => (
              <div key={role.id} className="role-card">
                <div className="role-card-header">
                  <span className="role-name">
                    {role.name}
                    {role.isSystem && (
                      <span className="badge badge-role">system</span>
                    )}
                    {role.isDefault && (
                      <span className="badge badge-running">default</span>
                    )}
                  </span>
                  {!role.isSystem && canManage && (
                    <button
                      className="btn-sm btn-danger"
                      onClick={() => handleDelete(role.id, role.name)}
                      disabled={busy}
                    >
                      Delete
                    </button>
                  )}
                </div>
                <div className="chip-list">
                  {allPerms.map((perm) => (
                    <button
                      key={perm}
                      className={`chip ${role.permissions.includes(perm) ? "chip-active" : ""}`}
                      onClick={() => handleTogglePerm(role.id, perm)}
                      disabled={role.isSystem || busy || !canManage}
                    >
                      {perm}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
