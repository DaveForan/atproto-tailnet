# ADR-0005: Tenant security management — composable role system

**Status:** Accepted (revised 2026-10-23)
**Date:** 2026-10-23

## Context

Tailnet owners need granular control over these items:

- Who can join their network
- What members can do
- Which devices are allowed

The first implementation used a binary owner/member role. It also used boolean permission flags for each member (`can_invite`, `can_kick`). This design was too rigid. A new permission needed a new column. The originator could not create custom roles or delegate role management.

Requirements (in priority order):

1. **Composable roles**: define roles with any set of permissions.
2. **Two system roles**: originator (all permissions, immutable) and citizen (default for new members, customizable).
3. **Role builder**: originators and authorized members can create, edit, and delete custom roles.
4. **Role assignment**: assign any role to any non-originator member.
5. **Default role**: set the role that new members receive when they accept an invitation.
6. **Originator protection**: nobody can remove the `isOriginator` boolean on the membership. Nobody can kick the originator.
7. **Eight discrete permissions**: invite, kick, manage_roles, manage_settings, approve_devices, lock_devices, view_audit_log, manage_devices.
8. **Device approval**: a configurable gate for new devices.
9. **Device locking**: bind a membership to specific machineKeys.
10. **Audit log**: an append-only record of all security-relevant actions, including role changes.
11. **Lockdown mode**: freeze all new joins and device registrations.

Non-goals for this iteration:

- IP allowlisting for each member (ACL-level, defer to Phase 4.1)
- Key rotation UI (pre-auth keys are already single-use and expire after 24 hours)
- Role hierarchy and inheritance (roles are flat permission sets)
- Permission scoping to specific resources (for example, "invite only these handles")

## Decision

### Composable role system

A `roles` table stores the role definitions for each tenant. Each role has these fields:

- `name`: unique for each tenant
- `permissions`: a JSONB array of permission strings from `ALL_PERMISSIONS`
- `is_system`: nobody can delete system roles (originator, citizen)

`src/routes/permissions.ts` defines the permission strings:

```
invite, kick, manage_roles, manage_settings,
approve_devices, lock_devices, view_audit_log, manage_devices
```

The originator system role always has all permissions. The code enforces this
with `membership.isOriginator`. It does not check the role.
The citizen system role starts empty. Users can customize its permissions.

### Membership changes

The `memberships` table adds these columns:

- `role_id` (FK → roles): the role of the member
- `is_originator` (boolean): hard protection for the tenant creator

The `is_originator` flag is the source of truth for the originator identity.
It has priority over any role assignment. The originator keeps
all permissions, even if the role of the originator changes by mistake.

### Tenant changes

The `tenants` table adds `default_role_id` (FK → roles). The system assigns
this role to new members when they accept invitations. During provisioning, the system
creates both system roles and sets citizen as the default.

### Permission checking

`hasPermission(membership, role, permission)` does these checks:
1. `membership.isOriginator` → true (short-circuit)
2. `role?.permissions.includes(permission)` → true/false

Destructive infrastructure operations (tenant delete/start/stop) stay
originator-only. They bypass the permission system.

### Dashboard tabs

Permissions control the visibility of tabs:
- The **Roles** tab is visible to users with `manage_roles`
- The **Security** tab is visible to users with `manage_settings` or `approve_devices`
- The **Audit Log** tab is visible to users with `view_audit_log`
- The Members tab shows a role assignment dropdown when the viewer has `manage_roles`

### Device approval flow

This flow is the same as in the first implementation. When `require_device_approval` is
true, auth-key requests create a pending `device_approvals` row. Users with
the `approve_devices` permission can approve or reject the request.

### Device locking

This feature is the same as before. `device_locks` binds a membership to specific machineKeys.
Users with the `lock_devices` permission can lock and unlock other members.

### Audit log

We added new actions: `role_created`, `role_updated`, `role_deleted`,
`member_role_changed`, `default_role_changed`. The system logs all role changes.

### Lockdown mode

This feature is the same as before. It is a boolean on the tenant. It blocks invitations, joins, and device
registration.

### Originator protection

`membership.isOriginator` enforces these rules:
- Nobody can kick the originator (hard 403)
- Nobody can change the role of the originator
- Nobody can assign the citizen role to the originator (the originator always has the originator role)
- Nobody can assign the originator role to a non-originator

## Consequences

- The migration adds the `roles` table, `memberships.role_id`/`is_originator`, `tenants.default_role_id`, and 5 new audit actions.
- We keep the legacy `memberships.role` enum and the `can_invite`/`can_kick` booleans for migration compatibility. New code does not use them.
- A JSONB permissions array is simpler than a junction table. It performs well for 8 permissions. If the permission set grows past ~50, review this decision.
- Custom roles apply to one tenant. There are no global role templates.
- When a role is deleted, the system unassigns the affected members (it sets `role_id = null`). These members have no permissions until an administrator assigns a new role.
