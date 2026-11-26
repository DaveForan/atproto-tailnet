# ADR-0020: Federation relay data plane

**Status:** Deferred: works in Headscale mode only; ADR-0033 replaces it in coordinator mode (tabled 2026-11-20)
**Date:** 2026-11-04
**Priority:** P0
**Depends On:** ADR-0006 (IP ranges), ADR-0010 (federation control plane), ADR-0016 (federation transport), ADR-0019 (cross-instance links)

> Note (2026-11-26): the Headscale mode was removed (ADR-0040). The coordinator is the only control plane.

## Context

Federation currently stops at the control plane. Two collectives can complete a
handshake and agree which CIDRs to share. They can install route auto-approvers
in the Headscale policy of each other (ADR-0016). But no packet can cross,
because nothing advertises those routes. `provisionRelayNode()` inserts a
database row and does nothing else.

ADR-0010 §4 decided that traffic crosses through broker-managed **relay
nodes** that are registered in both Headscale instances. It did not say how to
build such a node. The decision also depends on several questions that nobody
had tested:

- Does Headscale approve a route that is inside the tailnet address space?
- Does tailscaled forward such traffic?
- Does the far side see real source addresses?
- What must the policy contain?

We tested those questions in a throwaway Docker environment. It had two
Headscale 0.29.1 instances (A on `100.64.1.0/24`, B on `100.64.2.0/24`), one
plain Linux device in each, and a relay. The relay had two tailscale 1.104.4
nodes. One node joined A and advertised the prefix of B. The other node joined
B and advertised the prefix of A. A script runs the test
(`scripts/spikes/federation-relay/up.sh`, 25 assertions; `down.sh` removes
everything). We reproduced the run from a clean state. The findings:

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

Two properties of the current system conflict with these results:

- Every tenant defaults to the same range, `100.64.0.0/10`. Routing between two
  tailnets requires that their ranges do not overlap.
- Linux clients ignore advertised routes unless they start with
  `--accept-routes`. The connect instructions of the dashboard do not include
  this flag.

## Decision

### 1. A relay is two halves, one per collective

Each side of a link runs **its own relay half**. A relay half is a tailscaled
node that registers only in the Headscale of that collective. It advertises the
agreed CIDRs of the *peer* into its own tailnet. A private point-to-point link
joins the two halves. Each half forwards between that link and its tailnet
interface.

```
 tailnet A                relay half A        relay half B              tailnet B
 device ──(WireGuard)──▶ tailscale0 │ link ◀──────▶ link │ tailscale0 ──(WireGuard)──▶ device
            advertises B's CIDRs into A          advertises A's CIDRs into B
```

- **Same instance:** the link is an internal Docker network between the two
  half containers. We tested this configuration.
- **Different instances (ADR-0019):** each instance runs only its own half. The
  link is a WireGuard tunnel between the halves. The halves exchange the tunnel
  keys and endpoints over the established federation session.

We chose this shape over a single node that registers in both tailnets,
because it also works across instances. No instance issues credentials for its
Headscale to another operator. No device registers in a foreign tailnet.
Traffic is in the clear only inside a half that the collective controls whose
tailnet the traffic enters or leaves. The single-container variant worked in
testing. It would save one container for same-instance links. But it would be a
second code path that cannot extend across instances.

This replaces the "DERP relay bridge / direct peer-to-peer / hybrid"
description in ADR-0010 §4.

### 2. Relay half configuration

Each half is a container from a pinned tailscale image with `NET_ADMIN`,
`/dev/net/tun` and `net.ipv4.ip_forward=1`. The container starts with this
command:

```
tailscale up --login-server <tenant login server> --authkey <tagged key>
             --advertise-routes=<peer's agreed CIDRs>
             --snat-subnet-routes=false --netfilter-mode=off
```

The half also has a kernel route that sends the CIDRs of the peer over the
link. It has a firewall that the half owns outright:

```
FORWARD policy DROP
ACCEPT  tailscale0 → link   src <local CIDRs>  dst <peer CIDRs>
ACCEPT  link → tailscale0   src <peer CIDRs>   dst <local CIDRs>
```

A half therefore forwards exactly the agreed prefixes in each direction and
nothing else. This holds regardless of what either Headscale policy says. The
entrypoint of the container applies the routes and rules, so they survive
restarts.

### 3. Registration and route approval

The broker creates a single-use, short-lived pre-auth key. The key carries
`tag:federation-relay` and no user. The node registers as a tagged device. It
belongs to no member and counts against the devices of no one.

The policy edit that the broker already makes on session establishment
(ADR-0016 §4) approves the routes of the node. `tagOwners` declares the tag
with no owners, so no member can tag a device with it. `autoApprovers.routes`
lists the imported CIDRs for that tag. Only the broker can create a node that
can attract traffic for the addresses of a peer.

### 4. Each collective's ACL stays in charge

The system preserves source addresses end to end. The Headscale policy of a
collective therefore decides what the devices of a peer can reach. The policy
can name the addresses or CIDRs of the peer. Access needs a rule on **both**
sides. The tailnet of the caller must allow the destination. The tailnet of the
destination must admit the source.

On establishment, the broker adds a rule pair to the local policy. The pair
admits the agreed CIDRs of the peer to the local agreed CIDRs, and the reverse.
The broker removes the pair on teardown. Operators narrow the rules from there.
Traversal policy (ADR-0011) is the later mechanism that narrows access by
identity instead of address.

### 5. Tailnet ranges must not overlap

- The service allocates to each new tenant a distinct sub-prefix of
  `100.64.0.0/10` (and of `fd7a:115c:a1e0::/48`) instead of the whole range.
- The service refuses a link if the ranges or the offered CIDRs of the two
  collectives overlap (ADR-0019 §6). Inside an instance, the allocator
  prevents this. Across instances, it can happen, and one side must renumber
  (ADR-0006).
- An operator must renumber existing tenants on the default range before they
  can federate. Renumbering changes device addresses and restarts the instance.
  It is therefore an operator action and is never automatic.

### 6. Lifecycle

`relay_nodes` records one half for each session side: container id, Headscale
node id, link address, and status. The broker loop does these tasks:

- It provisions the half when its session becomes `established` and the
  instance of the tenant is running.
- It marks the half `active` when Headscale shows the node online with its
  routes approved. Otherwise it marks the half `unhealthy`. It recreates a half
  that stays unhealthy.
- On teardown, it removes the container, deletes the node from Headscale, and
  withdraws the policy entries.

Health checks use the Headscale node state and a real probe across the link. We
do not use `tailscale ping`. In testing, the relay itself answered it, and it
reported success for a path that did not carry traffic.

### 7. Client requirement

The connect instructions of the dashboard for Linux add `--accept-routes`. The
Federation tab says that devices without this flag will not reach federated
networks.

## Consequences

- Devices in one tailnet reach agreed addresses in another tailnet. No device
  registers in a foreign tailnet. The ACL of each collective, which matches
  real source addresses, remains the access control.
- Each instance side runs two containers for each link, with `NET_ADMIN`. The
  service already controls Docker. It now launches privileged network
  containers. The relay image and its entrypoint become part of the trusted
  base.
- WireGuard terminates at each relay half, so the half decrypts the traffic.
  Each collective must trust its own instance operator with that, as it already
  does for its Headscale. It does not have to trust the operator of the peer.
- Cross-tailnet traffic takes two extra hops, and both halves are on the
  critical path. One relay for each link is a single point of failure.
- Tenant creation changes (prefix allocation). Existing tenants need a
  disruptive renumbering before they can federate.
- Linux devices need a flag that they do not need today.

## To verify before or during implementation

The test run did not cover these items:

- **The cross-instance link.** A WireGuard tunnel between halves on different
  hosts, including when one host is behind NAT, and the message that exchanges
  its keys. Everything that we tested shared one Docker host.
- **Restart behaviour.** We must verify that the routes and firewall rules that
  the entrypoint reapplies are sufficient after a container or tailscaled
  restart.
- **A tenant that is still on `100.64.0.0/10`** and imports a prefix inside its
  own range. We did not test this case. §5 refuses it, and the design does not
  rely on it.
- **IPv6** across the relay. We advertised only IPv4 routes.
- **Non-Linux clients**, more than one device on each side, MTU and throughput.
- **DERP dependence.** The passing runs used the public DERP map of Tailscale
  with all paths direct. With only an unreachable DERP region, connectivity was
  intermittent. Relays and devices need a working DERP region or direct
  reachability.
- **Two relays that advertise the same route** (redundancy).

## Not in scope

- Split-horizon DNS across the link (ADR-0010 §6).
- Direct device-to-device paths that bypass the relay (ADR-0010 §4 "direct path
  upgrade").
- Transit and hierarchical route cascade (ADR-0010 §3).
