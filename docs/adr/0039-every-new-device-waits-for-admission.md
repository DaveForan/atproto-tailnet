# ADR-0039: Every new device waits for admission

**Status:** In Progress
**Date:** 2026-11-25
**Priority:** P0
**Depends On:** ADR-0023 (Rust mesh coordinator), ADR-0032 (device sign-in), ADR-0035 (device-bound access)
**Related:** ADR-0036 (device visibility), ADR-0029 (gateway node)

> Note (2026-11-26): the Headscale mode was removed (ADR-0040). The coordinator is the only control plane.

## Context

A device joined a tailnet in two ways: with an auth key, or with a sign-in on
the device (ADR-0032). Both had weak points:

- An auth key is a bearer secret. A person who gets the key adds any machine,
  and the machine has access at once. Nobody sees which machine joined.
- The optional device approval approved a request for a key, not a device.
  After the approval the key worked on any machine. The originator had no
  approval at all.
- The approval was a switch that was off by default.

The owner of the instance decided (2026-11-25): every new device is held, the
hold cannot be turned off, the owner of the device admits that exact machine,
and this applies to the originator and to every other member. A tailnet can
add a second approval by its approvers.

Changed the same day: the owner's approval is on by default and is each
member's own choice. A member can turn it off for their own devices. The
second approval locks it on for every member. A member, and the originator
for any member, can invalidate all devices and keys of that member.

## Decision

### The hold

Each device has a hold in the coordinator. It says who must admit the device
next:

- `owner`: the member who owns the device must admit it.
- `approver`: the owner admitted it, and an approver of the tailnet must admit
  it too.
- `none`: the device is admitted.

A held device is registered and has an address, but it has no access:

- It is no peer of any device, and it gets no peers, no names and no relay
  map. Its packet filter is empty.
- The relay refuses it. The gateway does not know it.
- Its netmap says `MachineAuthorized: false`. The Tailscale client then shows
  that the device waits for approval.

A hold only moves towards admission. Only a registration sets a hold.

### What sets the hold

- **Auth key.** A key registers a machine with the hold `owner`. It admits a
  machine only for a member who turned their own approval off (below).
- **Sign-in on the device.** The member sees the device name, system and key
  fingerprint on the sign-in page and selects **Add device**. This is the
  owner's admission of that exact machine. The device gets the hold `none`, or
  `approver` when the tailnet has the second approval.
- **A known machine.** A machine that registers again for the same owner keeps
  the steps that are done. For another owner it starts again.
- **Devices that exist** at the migration stay admitted.
- The gateway node of the coordinator is not a member device and has no hold.

### The member's own approval

The owner's step is on for every member by default
(`memberships.approve_own_devices`). A member can turn it off for their own
devices only: then a key of that member admits a device at once. A sign-in on
the device always shows the approval page.

- Only the member changes it: session only, fresh device proof, not in
  lockdown. No originator, operator, role or agent token changes it for a
  member.
- The second approval locks it on for every member, the originator too.
  Each change of the second approval sets every member's choice back to on.
- The service sends the coordinator the owners who turned it off
  (`unheld_owners` in the tenant access config). The list is empty while the
  second approval is on. A key without an owner never admits a machine.

- The dashboard never shows more protection than the coordinator gives. The
  second approval is saved only after the coordinator took the change. When
  the push of a member's own choice fails, the choice is stored as off, the
  service answers 502 `not_applied`, and the person tries again.

There is no tailnet-wide or instance-wide switch that turns the hold off.

### Invalidation

A member can remove all their devices in a tailnet and revoke all their keys
there in one step. The originator and a member with `manage_devices` can do
this for any member. The member stays a member. It only removes access, so
lockdown does not block it.

### Who admits

- Only the owner takes the owner's step. The originator, an operator and a
  member with `approve_devices` or `manage_devices` cannot take it for another
  member. An approver takes it only for a device without an owner in the
  tailnet.
- The second approval is the tailnet setting `requireDeviceApproval`
  ("Approvers also admit new devices"). It is off by default. An approver is
  the originator or a member with `approve_devices`.
- An approver does not approve their own device. The device of an approver,
  and of the originator, waits for a different approver. Only when the owner
  is the single approver of the tailnet does their own admission finish it.
- The owner or an approver can refuse a waiting device. A refused device is
  removed.
- A device that nobody admits is removed after one week. The originator can
  set another time, from one hour to one year. The removed device can be
  added again.
- The owner gets a notification when a device registers with one of their
  keys and waits.
- Admission needs a dashboard session and a fresh device proof (step-up).
  Agent tokens and the MCP connector cannot admit a device. Lockdown blocks
  admission.
- The device limit counts admitted devices: at key issuance, at the sign-in
  page and at the last admission step. A device that waits is not counted.
- When the tailnet drops the second approval, a device that still waits for an
  approver is its owner's to finish. An approver can also still admit it.
- Each step is audited with the fingerprint of the machine.

### The fingerprint

The fingerprint is the short form of the machine key that the Tailscale client
makes on the device. It is the only strong identifier the client gives. The
device name and system come from the device and can be false: the dashboard
shows them, and no decision uses them.

## Consequences

- A stolen or leaked auth key adds no device with access, unless its owner
  turned their own approval off. The owner of the key sees an unknown machine
  wait and refuses it.
- Unattended installation with a key needs one more step: the owner admits the
  device in the dashboard.
- A phone joins with a sign-in and no key, also in a tailnet with the second
  approval.
- A person who copies the state of an admitted client to another machine has
  the same machine key. The server cannot see this. The machine lock
  (ADR-0035) does not prevent it either.
- Headscale mode (legacy) has no hold. It keeps the older approval of key
  requests.

## Acceptance

- A machine that registers with a valid key gets no peers and no relay until
  its owner admits it.
- The originator cannot admit the device of another member in the owner's
  place.
- With the second approval, the owner's step alone gives no access.
- An admitted device gets its peers without a new sign-in.

## Implementation notes

Built:

- **Coordinator.** `coord_core::Hold` on each node (`coord_nodes.hold`,
  migration 018 for PostgreSQL and 015 for SQLite, in all three stores).
  `get_peers` and `get_peers_with_children` leave held nodes out, so netmaps,
  DNS views and the gateway never see them. `NetmapService::build_snapshot`
  gives a held node only its own node. `StoreAdmission` refuses a held node at
  the relay. `PUT /api/tenants/{id}/nodes/{node_id}/hold` moves a hold from the
  value the caller saw (409 otherwise) and never up. The sign-in decision
  carries the hold; without one the device waits for its owner.
- **Service.** `access/device-holds.ts` (`admitStep`, `holdAfterOwner`) and
  `routes/device-holds.ts`: `GET .../devices/waiting`,
  `POST .../devices/:nodeId/admit`, `POST .../devices/:nodeId/refuse`.
  `listTenantDevices` leaves held devices out, so no service, share or rule
  can select one.
- **Own approval and invalidation.** `GET/PUT .../device-approval/mine`
  (409 `approval_locked` with the second approval) and
  `POST .../members/:userId/devices/invalidate` in `routes/device-holds.ts`;
  `TenantAccess::key_admits` in the coordinator; drizzle migration 0043.
  Devices → Access has the card "Protection of my devices"; People has
  **Invalidate devices** per member.
- **Dashboard.** Overview lists the waiting devices under "Needs your
  attention" with name, system, fingerprint, **Admit** and **Refuse**. The
  device list marks a waiting device.

Not confirmed with a real Tailscale client: what the apps show while a device
waits (`MachineAuthorized: false` with an empty map), and that a device
connects by itself after admission without a restart of the app. The server
side does not depend on the client: a held device gets no peers and no relay.

- **Watch and expiry.** `orchestrator/waiting-devices.ts` runs in the monitor
  (each minute, leader only). It records when each wait began
  (`waiting_devices`), tells the owner about a device that their key
  registered (`device_waiting`; the approvers for a device without an owner),
  and removes a device that waited longer than `tenants.waitingDeviceHours`
  (default 168, 1 to 8760; the originator sets it with `PUT .../limits`).
  The removal is audited as `device_expired`. Drizzle migration 0044.
- **Connector.** `get_my_device_approval` (read) and
  `invalidate_member_devices`. No tool admits a device or changes a member's
  own approval.
