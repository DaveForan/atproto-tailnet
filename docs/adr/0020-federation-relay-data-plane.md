# ADR-0020: Federation relay data plane

**Status:** In Progress
**Date:** 2026-11-04
**Priority:** P0
**Depends On:** ADR-0006 (IP ranges), ADR-0010 (federation control plane), ADR-0016 (federation transport), ADR-0019 (cross-instance links)

## Context

Federation currently stops at the control plane. Two collectives can
complete a handshake, agree which CIDRs to share, and install route
auto-approvers in each other's Headscale policy (ADR-0016) — but no packet
can cross, because nothing advertises those routes. `provisionRelayNode()`
inserts a database row and nothing else.

ADR-0010 §4 decided that traffic crosses via broker-managed **relay
nodes** registered in both Headscale instances, but did not say how such a
node is built, and several things it depends on had never been tried:
whether Headscale will approve a route that lies inside the tailnet
address space, whether tailscaled will forward such traffic, whether the
far side sees real source addresses, and what the policy must contain.

Those questions were tested in a throwaway Docker environment: two
Headscale 0.29.1 instances (A on `100.64.1.0/24`, B on `100.64.2.0/24`),
one plain Linux device in each, and a relay made of two tailscale 1.104.4
nodes — one joined to A advertising B's prefix, one joined to B advertising
A's. The run is scripted (`scripts/spikes/federation-relay/up.sh`, 25
assertions; `down.sh` removes everything) and was reproduced from a clean
state. Findings:

| Question | Result |
|----------|--------|
| Per-tenant sub-prefixes of `100.64.0.0/10` | Accepted; devices allocated from them |
| A subnet route that is itself inside `100.64.0.0/10` | Advertised, approved, and installed by Linux clients started with `--accept-routes` |
| Forwarding with tailscaled's default firewall rules | **Fails.** Its `ts-forward` chain drops forwarded packets with a CGNAT source |
| Default firewall plus a manual ACCEPT | Works until tailscaled reinstalls its hooks above the rule — not dependable |
| `--netfilter-mode=off` with our own rules | **Works** |
| Default source NAT on the relay | **Fails** — nothing reaches the far device |
| `--snat-subnet-routes=false` | **Works**, and the far device sees the caller's real tailnet address |
| Each tenant's ACL applies to cross-tailnet traffic | Yes, per direction, matching on the real source; replies to an allowed flow pass |
| Policy: `autoApprovers.routes` for `tag:federation-relay` with `tagOwners: {"tag:federation-relay": []}` | Accepted; the relay's route is approved with no manual step |
| Policy: approver `"*"` | Rejected (`invalid auto approver format`) |
| Policy: tag approver not declared in `tagOwners` | Rejected (`tag not found`) |
| Registering the relay as a tagged node | `POST /api/v1/preauthkey` with `aclTags` and no `user` |
| Relay as two containers joined by a private network | Works |
| Relay as one container running two tailscaled processes | Works (lighter testing) |

Two properties of the system as it stands conflict with these results:

- Every tenant defaults to the same range, `100.64.0.0/10`. Routing
  between two tailnets requires that their ranges do not overlap.
- Linux clients ignore advertised routes unless started with
  `--accept-routes`; the dashboard's connect instructions do not include it.

## Decision

### 1. A relay is two halves, one per collective

Each side of a link runs **its own relay half**: a tailscaled node
registered only in that collective's Headscale, advertising the *peer's*
agreed CIDRs into its own tailnet. The two halves are joined by a private
point-to-point link and forward between it and their tailnet interface.

```
 tailnet A                relay half A        relay half B              tailnet B
 device ──(WireGuard)──▶ tailscale0 │ link ◀──────▶ link │ tailscale0 ──(WireGuard)──▶ device
            advertises B's CIDRs into A          advertises A's CIDRs into B
```

- **Same instance:** the link is an internal Docker network between the
  two half containers. This is the configuration that was tested.
- **Different instances (ADR-0019):** each instance runs only its own
  half, and the link is a WireGuard tunnel between the halves, with the
  tunnel keys and endpoints exchanged over the established federation
  session.

This shape is chosen over a single node registered in both tailnets
because it holds across instances: no instance ever issues credentials for
its Headscale to another operator, no device registers in a foreign
tailnet, and traffic is only ever in the clear inside a half controlled by
the collective whose tailnet it is entering or leaving. The single-
container variant worked in testing and would save a container for
same-instance links, but it would be a second code path that cannot extend
across instances.

This replaces the "DERP relay bridge / direct peer-to-peer / hybrid"
description in ADR-0010 §4.

### 2. Relay half configuration

Each half is a container from a pinned tailscale image with `NET_ADMIN`,
`/dev/net/tun` and `net.ipv4.ip_forward=1`, started as:

```
tailscale up --login-server <tenant login server> --authkey <tagged key>
             --advertise-routes=<peer's agreed CIDRs>
             --snat-subnet-routes=false --netfilter-mode=off
```

plus a kernel route sending the peer's CIDRs over the link, and a firewall
the half owns outright:

```
FORWARD policy DROP
ACCEPT  tailscale0 → link   src <local CIDRs>  dst <peer CIDRs>
ACCEPT  link → tailscale0   src <peer CIDRs>   dst <local CIDRs>
```

So a half forwards exactly the agreed prefixes in each direction and
nothing else, regardless of what either Headscale policy says. Routes and
rules are applied by the container's entrypoint so they survive restarts.

### 3. Registration and route approval

The broker creates a single-use, short-lived pre-auth key carrying
`tag:federation-relay` and no user. The node registers as a tagged device
— it belongs to no member and counts against no one's devices.

The policy edit the broker already makes on session establishment
(ADR-0016 §4) is what approves its routes: `tagOwners` declares the tag
with no owners, so no member can tag a device with it, and
`autoApprovers.routes` lists the imported CIDRs for that tag. Only the
broker can create a node able to attract traffic for a peer's addresses.

### 4. Each collective's ACL stays in charge

Source addresses are preserved end to end, so a collective's own Headscale
policy decides what a peer's devices may reach, and can name the peer's
addresses or CIDRs. Access needs a rule on **both** sides: the caller's
tailnet must allow the destination, and the destination's tailnet must
admit the source.

On establishment the broker adds a rule pair to the local policy admitting
the peer's agreed CIDRs to the local agreed CIDRs and the reverse, and
removes it on teardown. Operators narrow it from there; traversal policy
(ADR-0011) is the later mechanism for doing so by identity rather than
address.

### 5. Tailnet ranges must not overlap

- New tenants are allocated a distinct sub-prefix of `100.64.0.0/10` (and
  of `fd7a:115c:a1e0::/48`) instead of the whole range.
- A link is refused if the two collectives' ranges or offered CIDRs
  overlap (ADR-0019 §6). Within an instance the allocator prevents this;
  across instances it can happen, and one side must renumber (ADR-0006).
- Existing tenants on the default range must be renumbered before they can
  federate. Renumbering changes device addresses and restarts the
  instance, so it is an operator action, never automatic.

### 6. Lifecycle

`relay_nodes` records one half per session side: container id, Headscale
node id, link address, status. The broker loop:

- provisions the half when its session becomes `established` and the
  tenant's instance is running;
- marks it `active` once Headscale shows the node online with its routes
  approved, `unhealthy` otherwise, and recreates a half that stays
  unhealthy;
- on teardown removes the container, deletes the node from Headscale, and
  withdraws the policy entries.

Health checks use the Headscale node state and a real probe across the
link. `tailscale ping` is not used: in testing it was answered by the
relay itself and reported success for a path that was not carrying
traffic.

### 7. Client requirement

The dashboard's connect instructions for Linux add `--accept-routes`, and
the Federation tab says that devices without it will not reach federated
networks.

## Consequences

- Devices in one tailnet reach agreed addresses in another with no device
  registered in a foreign tailnet, and each collective's ACL — matching
  real source addresses — remains the access control.
- Two containers per link per instance side with `NET_ADMIN`; the service,
  which already controls Docker, now launches privileged network
  containers. The relay image and its entrypoint become part of the
  trusted base.
- Traffic is decrypted at each relay half (WireGuard terminates there).
  Each collective must trust its own instance operator with that, as it
  already does for its Headscale; it does not have to trust the peer's.
- An extra two hops for cross-tailnet traffic, and both halves on the
  critical path. One relay per link is a single point of failure.
- Tenant creation changes (prefix allocation), and existing tenants need a
  disruptive renumbering before they can federate.
- Linux devices need a flag they do not need today.

## To verify before or during implementation

Not covered by the test run:

- **The cross-instance link.** A WireGuard tunnel between halves on
  different hosts, including when one is behind NAT, and the message that
  exchanges its keys. Everything tested shared one Docker host.
- **Restart behaviour.** That routes and firewall rules reapplied by the
  entrypoint are sufficient after a container or tailscaled restart.
- **A tenant still on `100.64.0.0/10`** importing a prefix inside its own
  range. Not tested; refused by §5 rather than relied on.
- **IPv6** across the relay. Only IPv4 routes were advertised.
- **Non-Linux clients**, more than one device per side, MTU and
  throughput.
- **DERP dependence.** The passing runs used Tailscale's public DERP map
  with all paths direct. With only an unreachable DERP region, connectivity
  was intermittent — relays and devices need a working DERP region or
  direct reachability.
- **Two relays advertising the same route** (redundancy).

## Not in scope

- Split-horizon DNS across the link (ADR-0010 §6).
- Direct device-to-device paths that bypass the relay (ADR-0010 §4
  "direct path upgrade").
- Transit and hierarchical route cascade (ADR-0010 §3).
