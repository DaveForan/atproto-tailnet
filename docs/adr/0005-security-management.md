# ADR-0005: Tenant security management — composable role system

**Status:** Accepted (revised 2026-10-23)
**Date:** 2026-10-23

## Context

Tailnet owners need granular control over who can join their network, what
members can do, and which devices are allowed. The initial implementation
used a binary owner/member role with per-member boolean permission flags
(`can_invite`, `can_kick`). This was too rigid — adding new permissions
meant new columns, and there was no way for the originator to create
custom roles or delegate role management.

Requirements (prioritized):

1. **Composable roles** — define roles with arbitrary permission sets
2. **Two system roles** — originator (all perms, immutable) and citizen (default for new members, customizable)
3. **Role builder** — originators and authorized members can create, edit, and delete custom roles
4. **Role assignment** — assign any role to any non-originator member
5. **Default role** — set which role new members get on invitation acceptance
6. **Originator protection** — the `isOriginator` boolean on membership can never be removed; originator cannot be kicked
7. **Eight discrete permissions** — invite, kick, manage_roles, manage_settings, approve_devices, lock_devices, view_audit_log, manage_devices
8. **Device approval** — configurable gate for new devices
9. **Device locking** — bind membership to specific machineKeys
10. **Audit log** — append-only record of all security-relevant actions including role mutations
11. **Lockdown mode** — freeze all new joins and device registrations

Non-goals for this iteration:

- IP allowlisting per member (ACL-level, defer to Phase 4.1)
- Key rotation UI (pre-auth keys already single-use, 24h expiry)
- Role hierarchy / inheritance (roles are flat permission sets)
- Permission scoping to specific resources (e.g., "invite only these handles")

## Decision

### Composable role system

A `roles` table stores per-tenant role definitions. Each role has:

- `name` — unique per tenant
- `permissions` — JSONB array of permission strings from `ALL_PERMISSIONS`
- `is_system` — system roles (originator, citizen) cannot be deleted

Permission strings are defined in `src/routes/permissions.ts`:

```
invite, kick, manage_roles, manage_settings,
approve_devices, lock_devices, view_audit_log, manage_devices
```

The originator system role always has all permissions (enforced in code via
`membership.isOriginator`, not by checking the role). The citizen system
role starts empty but can have its permissions customized.

### Membership changes

The `memberships` table adds:

- `role_id` (FK → roles) — the member's assigned role
- `is_originator` (boolean) — hard protection for the tenant creator

The `is_originator` flag is the source of truth for originator identity —
it takes precedence over any role assignment. This ensures the originator
retains all permissions even if their role is somehow changed.

### Tenant changes

The `tenants` table adds `default_role_id` (FK → roles). New members who
accept invitations are assigned this role. During provisioning, both system
roles are created and citizen is set as the default.

### Permission checking

`hasPermission(membership, role, permission)` checks:
1. `membership.isOriginator` → true (short-circuit)
2. `role?.permissions.includes(permission)` → true/false

Destructive infrastructure operations (tenant delete/start/stop) remain
originator-only and bypass the permission system entirely.

### Dashboard tabs

Tab visibility is permission-gated:
- **Roles** tab visible to users with `manage_roles`
- **Security** tab visible to users with `manage_settings` or `approve_devices`
- **Audit Log** tab visible to users with `view_audit_log`
- Members tab shows role assignment dropdown when viewer has `manage_roles`

### Device approval flow

Unchanged from initial implementation. When `require_device_approval` is
true, auth-key requests create a pending `device_approvals` row. Users with
`approve_devices` permission can approve or reject.

### Device locking

Unchanged. `device_locks` binds a membership to specific machineKeys.
Users with `lock_devices` permission can lock/unlock other members.

### Audit log

Extended with new actions: `role_created`, `role_updated`, `role_deleted`,
`member_role_changed`, `default_role_changed`. All role mutations are logged.

### Lockdown mode

Unchanged. Boolean on tenant; blocks invitations, joins, and device
registration.

### Originator protection

Enforced via `membership.isOriginator`:
- Cannot be kicked (hard 403)
- Cannot have role changed
- Cannot be assigned the citizen role (they always have originator role)
- The originator role itself cannot be assigned to non-originators

## Consequences

- Migration adds `roles` table, `memberships.role_id`/`is_originator`, `tenants.default_role_id`, and 5 new audit actions.
- Legacy `memberships.role` enum and `can_invite`/`can_kick` booleans are preserved for migration compatibility but not used by new code.
- JSONB permissions array is simpler than a junction table and performs fine for 8 permissions. If the permission set grows past ~50, revisit.
- Custom roles are tenant-scoped — no global role templates.
- Role deletion unassigns affected members (sets `role_id = null`), which grants no permissions until reassigned.
