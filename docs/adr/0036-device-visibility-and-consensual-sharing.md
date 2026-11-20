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
- A board shows **solicitations** only: a member offers a service on one
  device and one port. The tailnet has a public board. Each member also has a
  private board for services that only their own devices use, at private DNS
  names.
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

### 2. Boards

The boards are the interface where members create and expose services. There
are three boards, with three audiences.

| Board | Audience | Content | Who writes |
|---|---|---|---|
| Controller board | The internet (WAN, public) | Text about the tailnet | The originator of the tailnet |
| Public board | Members of the tailnet | Solicitations: services offered to members | Each member |
| Private board | The devices of one member | Services of that member for their own devices | That member |

**Controller board (WAN, public).** The public page of the tailnet. The
operator of the tailnet (the originator) uses it for administrative
information: the purpose of the tailnet, how to join, contact data, or any
other message. It contains no solicitations, no devices and no ports.

- The content is text only. The originator writes it in the dashboard in a
  small subset of Markdown: headings, paragraphs, bold, italic, lists and
  links. Our code parses the subset and renders plain elements. Everything
  else shows as literal text. There is no HTML, no script, no image and no
  embedded content, so the page needs no sandbox.
- Links must use `https://`. They open in a new tab with `rel="noopener
  noreferrer nofollow"`.
- On save, the service refuses control characters, invisible and
  direction-changing Unicode characters, links that are not `https://`, and
  text above the size limit (4000 characters). The editor shows a preview of
  what visitors see.
- The landing page of the instance shows the controller board of the default
  tailnet below the sign-in form. Each tailnet also has its board at
  `/board/<tailnet-address>`. Sign-in stays our own form.

**Public board (tailnet, public).** Visible only to members of the tailnet,
after sign-in. It lists solicitations: services that members offer to other
members.

**Private board (tailnet, private).** One for each member. It lists the
services that the member runs for their own devices. Only that member sees it.
Each entry is one device, one port and a name. The devices of the member reach
the service at a private DNS name, `<name>.<BASE_DOMAIN>` (for example
`notes.ts.mesotechnics.cloud`). The coordinator sends the DNS record only to
the devices of that member (ADR-0028), so the name does not resolve for other
members or on the internet. Two members can use the same private name. A member
moves an entry to the public board to offer it to other members; the name must
then be free in the tailnet.

The public board and the private board hold solicitations only. Each entry is
bound to a device and a port.

There are two ways for a member to reach a device of another member: a
service on the public board (below), or a share between friends (section 3).

**Service posts on the public board.** One process combines the service, its
device and the board post.

1. **Create.** A member creates a service post: a title, a description, one
   device and one port (TCP or UDP). The device is one of the devices of the
   member, or a new device that the member enrolls in this step (the post
   shows the key and the command). A device with a service post is a **service
   device**.
2. **Approve.** The post is not visible to other members until an operator of
   the tailnet approves it (the originator, or a holder of
   `approve_services`). Approvers get a notification. A post of the originator
   needs no approval. A refused post stays visible to its author with the
   reason.
3. **Solicit.** The approved post is on the public board. It alone opens
   nothing. Next to it there is a **Connect** button. The viewer selects one or
   more of their own devices. The selected devices can then reach that device
   and that port, and no other port. The board shows the address to use
   (tailnet address and port; the name of the service when ADR-0030 is built).
4. **End.** The viewer can disconnect a device at any time. The author can
   remove the post, and an operator can remove it or withdraw the approval.
   Access ends at once for all connected devices.

- A member who runs two applications on one device (one for everybody on one
  port, one for their own devices on another port) posts only the first port.
  The second port stays private.
- A change of the device or the port of an approved post needs a new approval.
- The author sees how many members and devices are connected, and can remove
  one of them.
- The private board needs no approval: it only concerns the devices of its
  owner.

### 3. Friends and shares between members

Two members become **friends** when one sends a friend request and the other
accepts. Only friends can ask for access to the devices of each other. Either
member can end the friendship; all shares between them then end.

A **share** gives the devices of one member access to a device of a friend. It
has a direction: the *owner* exposes, the *guest* connects.

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

Administrators control solicitations, because all members of the tailnet see
them. The originator also writes the controller board. They do not control private shares between members.

- A service post is visible on the public board only after the originator or
  a holder of `approve_services` approves it. Holders of `manage_board` can
  remove a post.
- The originator, or a holder of `manage_acl`, selects the access mode of the
  tailnet: `member` (this ADR), `open`, or `custom` (the ACL policy). The
  originator can turn off the board, or shares, for the whole tailnet.
- Administrators cannot read, change or create shares of other members.
- The audit log records solicitations, and that a share started or ended (not
  its scope, which belongs to the two members).

### 4b. First version

Included: friends, an expiry on each share (the interface asks for it), one
screen per device that shows who can reach it with "stop all sharing",
notifications, protocol with the port (TCP, UDP, ICMP), a block list (a
blocked member cannot send friend requests), and limits on pending requests
with a cool-down after a refusal.

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
- Member A creates a service post for port 3000 of a device and runs a
  private application on port 4000 of the same device. Before an operator
  approves the post, member B does not see it. After the approval, B presses
  Connect and selects one
  device. That device reaches port 3000 and not port 4000. The other devices of
  B, and member C who did not connect, reach nothing.
- A holder of `manage_board` removes the solicitation. B loses access.
- A puts `notes` on port 8080 on their private board. On the devices of A,
  `notes.<BASE_DOMAIN>` resolves to that device. On the devices of B the name
  does not resolve, and B cannot see the entry.
- The public and private boards accept no entry that is not bound to a device
  and a port.
- The controller board is readable without sign-in and shows no device, port
  or member. HTML or script in its text shows as literal text.
- An administrator cannot list or change a share between A and B.
- A cannot request access to a device of B before they are friends.
- A requests access to a device of B. Before B accepts, nothing changes. After
  B accepts ports 22 and 443 only, A reaches those two ports only.
- B ends the share. A loses access in less than 5 seconds.
- A device of A that is not in the share cannot connect.
