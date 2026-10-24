# ADR-0005: Tenant security management and device approval

**Status:** Accepted
**Date:** 2026-10-23

## Context

Tailnet owners need granular control over who can join their network, what
members can do, and which devices are allowed. The current system has a
binary owner/member role model: owners can do everything, members can only
connect devices and view the network. There is no audit trail, no device
approval gate, and no way to delegate invite or kick permissions.

Requirements (prioritized):

1. Member visibility — see everyone on the tailnet with their permissions
2. Delegated permissions — owner toggles per-member invite/kick rights
3. Originator protection — the tenant creator can never be removed
4. Device approval — owner can require approval before new devices join
5. Device locking — users can bind their membership to specific machines
6. Audit log — immutable record of all security-relevant actions
7. Emergency lockdown — freeze all new joins and device registrations

Non-goals for this iteration:

- IP allowlisting per member (ACL-level, defer to Phase 4.1)
- Key rotation UI (pre-auth keys already single-use, 24h expiry)
- Role hierarchy beyond owner/member (e.g., "admin" tier)

## Decision

### Permission model

Keep the two-role enum (owner, member). Add per-member boolean permission
columns (`can_invite`, `can_kick`) to the `memberships` table. The owner's
permissions are always true by code convention — never stored or checked.
This avoids enum proliferation while giving fine-grained delegation.

### Device approval flow

Add a `device_approvals` table. When `require_device_approval` is true on
a tenant, `POST .../devices/auth-key` creates an approval request instead
of a Headscale pre-auth key. The owner (or a member with `can_invite`)
approves, which triggers key generation. The key is stored in the approval
record for the requester to retrieve.

### Device locking

A `device_locks` table records Headscale `machineKey` values that a user
has bound to their membership. When locks exist, new auth-key generation
for that user requires removing the lock first. This prevents credential
theft from silently adding rogue devices.

### Audit log

An append-only `audit_logs` table records actor, action, target, and a
JSONB metadata payload for every security-relevant mutation. The table has
no UPDATE or DELETE exposed in the application layer. Retention is
configurable (default 90 days, cleanup via utility function).

### Lockdown mode

A boolean `lockdown_mode` on the tenant. When true: no new invitations,
no invitation acceptance, no new auth keys. Existing connections remain
active (disconnecting them requires explicit node deletion).

### Originator protection

The membership deletion endpoint hard-checks: if the target membership
role is `owner`, the request is rejected with 403. This is enforced at
the route level, not the permission level — it cannot be bypassed by
any permission combination.

## Consequences

- Migration adds 3 new tables and 4 new columns across 2 existing tables.
- All permission checks route through a shared `hasPermission()` helper
  to avoid scattered role logic.
- The audit log grows unbounded without cleanup; a utility function handles
  retention-based pruning.
- Device approval adds latency to the "add device" flow when enabled.
- Lockdown mode is a blunt instrument — it blocks everything, not
  selectively. Fine-grained suspension is a future enhancement.
