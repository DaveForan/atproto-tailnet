# ADR-0036: Device visibility and consensual sharing

**Status:** Proposed
**Date:** 2026-11-20
**Priority:** P0
**Depends On:** ADR-0005 (security management), ADR-0023 (Rust mesh coordinator)
**Related:** ADR-0030 (named tailnet services), ADR-0035 (device-bound access)

## Context

With no ACL policy, the coordinator sends every device an allow-all packet
filter. Every device of a tailnet can reach every port of every other device,
and every device sees all other devices. A member who runs a private service on
a laptop exposes it to all members.

The ACL policy that exists is one set of rules for the whole tailnet. Only a
holder of `manage_acl` can change it. A member has no control over the access
to their own devices.

The operator requires this model:

- By default, a member reaches only their own devices.
- A **published service** is a device that offers a service through the board.
  Members can choose to see published services.
- Members can ask to see the devices of other members, and can show their own
  devices to other members. Both members must agree.
- Each member controls which of their devices and which ports are exposed.

## Decision

### 1. Default: own devices only

For a tailnet in the `member` access mode (the default for new tailnets), a
device accepts traffic only from devices of the same owner. A device sees only
the peers that it can reach or that can reach it.

Existing tailnets keep the `open` mode (allow all) until the originator changes
it. A tailnet with a custom ACL policy stays in the `custom` mode.

### 2. Published services

- A member publishes a service on one of their devices: a name and a TCP port
  (or a port range), with a board post.
- Each member has a setting **See published services** (off by default), for
  all of their devices or per device.
- A device of a member with this setting reaches the published port of the
  publishing device, and no other port.
- The publisher can stop publishing at any time. Access ends at once.
- Named HTTPS services through the gateway (ADR-0030) build on this record.

### 3. Shares between members

A **share** gives the devices of one member access to a device of another
member. It has a direction: the *owner* exposes, the *guest* connects.

- Scope, chosen by the owner: one device, and a list of ports or port ranges
  (or all ports). One share per device, so each device can have different
  ports.
- The guest can limit the share to some of their own devices.
- **Both members must agree.** A share starts as a request from the guest
  ("let me reach your device") or as an offer from the owner ("you can reach my
  device"). It becomes active only when the other member accepts. The owner can
  narrow the scope when they accept a request; the guest then sees the final
  scope before it is active.
- Access in the other direction is a second share. The interface offers "share
  both ways", which creates two shares that the members accept together.
- Either member can end a share at any time. Access ends at once. Both members
  get a notification.
- A share can have an expiry.
- Lockdown blocks new shares. Removal of a member ends their shares.

### 4. Controls of the originator

- The originator, or a holder of `manage_acl`, selects the access mode of the
  tailnet: `member` (this ADR), `open`, or `custom` (the ACL policy).
- In the `member` mode, the originator can turn off shares between members or
  published services for the whole tailnet.
- The audit log records shares and published services.

### 5. Enforcement

- The TS service is the source of truth for shares, published services and
  member settings. It compiles them into access rules for the coordinator:
  `(source devices, destination device, ports)`.
- The coordinator builds the packet filter of each device from the owner rule
  and the access rules, and limits the peers in the netmap to the same set.
  Connected devices get the change at once.
- The rules are kept in the coordinator store (not only in memory), so that
  they hold after a restart and with more than one replica (ADR-0034).
- The DERP relay already refuses traffic between tailnets. It does not need to
  know these rules: the packet filter on the device refuses the traffic.

## Consequences

- A new member cannot reach anything of other members until somebody shares or
  publishes. The interface must make "publish" and "share" easy to find.
- Members control their own exposure, per device and per port.
- The packet filter and the peer list are now different for each device. The
  netmap code changes from one filter per tailnet to one per device.
- The Services and Board features get a real network meaning: a published
  service opens a port.

## Acceptance

- New tailnet, two members: neither reaches a device of the other.
- Member A publishes port 3000 on a device. Member B, with "See published
  services" on, reaches port 3000 and no other port. Member C, with the setting
  off, reaches nothing.
- A requests access to a device of B. Before B accepts, nothing changes. After
  B accepts ports 22 and 443 only, A reaches those two ports only.
- B ends the share. A loses access in less than 5 seconds.
- A device of A that is not in the share cannot connect.
