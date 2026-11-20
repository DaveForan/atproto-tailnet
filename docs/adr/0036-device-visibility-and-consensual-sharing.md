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
- The board shows **solicitations**: a member offers a service on one device
  and one port. Each other member chooses which of their own devices connect
  to it.
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

### 2. Solicitations on the board

The board lists **solicitations**: open offers of a service that a member runs.

- A solicitation is for one device and one port (TCP or UDP) of the member who
  posts it, with a title and a description. A member who runs two applications
  on one device (one for everybody on one port, one for their own devices on
  another port) solicits only the first port. The second port stays private.
- A solicitation alone opens nothing. Next to each solicitation there is a
  **Connect** button. The viewer selects one or more of their own devices. The
  selected devices can then reach that device and that port, and no other
  port. The board shows the address to use (tailnet address and port; the name
  of the service when ADR-0030 is built).
- The post is the consent of the publisher. The **Connect** action is the
  consent of the viewer. No approval step is necessary for each viewer.
- The viewer can disconnect a device at any time. The publisher can remove the
  solicitation at any time. Access ends at once for all connected devices.
- The publisher sees how many members and devices are connected, and can
  remove one of them.

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

### 4. Controls of administrators

Administrators control solicitations, because solicitations are public to the
tailnet. They do not control private shares between members.

- Holders of `manage_board` can remove a solicitation. If the tailnet requires
  service approval (`requireServiceApproval`), a solicitation is visible only
  after a holder of `approve_services` approves it.
- The originator, or a holder of `manage_acl`, selects the access mode of the
  tailnet: `member` (this ADR), `open`, or `custom` (the ACL policy). The
  originator can turn off the board, or shares, for the whole tailnet.
- Administrators cannot read, change or create shares of other members.
- The audit log records solicitations, and that a share started or ended (not
  its scope, which belongs to the two members).

### 4b. First version

Included: an expiry on each share (the interface asks for it), one screen per
device that shows who can reach it with "stop all sharing", shares to a role
(each member of the role accepts for themselves), notifications, protocol with
the port (TCP, UDP, ICMP), a block list, and limits on pending requests with a
cool-down after a refusal.

Later: last-use information for shares, and shares between a tailnet and its
sub-tailnets. When ADR-0035 is built, a member with trusted devices must
confirm on a trusted device to accept or widen a share.

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
- Member A solicits port 3000 of a device and runs a private application on
  port 4000 of the same device. Member B presses Connect and selects one
  device. That device reaches port 3000 and not port 4000. The other devices of
  B, and member C who did not connect, reach nothing.
- A holder of `manage_board` removes the solicitation. B loses access.
- An administrator cannot list or change a share between A and B.
- A requests access to a device of B. Before B accepts, nothing changes. After
  B accepts ports 22 and 443 only, A reaches those two ports only.
- B ends the share. A loses access in less than 5 seconds.
- A device of A that is not in the share cannot connect.
