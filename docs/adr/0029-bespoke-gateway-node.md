# ADR-0029: Bespoke gateway node (`coord-gateway`)

**Status:** Proposed
**Date:** 2026-11-19
**Priority:** P1
**Depends On:** ADR-0023 (Rust mesh coordinator), ADR-0027 (DERP relay)
**Related:** ADR-0020 (federation relay data plane), ADR-0024 (purpose-built mesh client)

## Context

Three features need a server-side node that is inside tailnets and carries
traffic for them:

1. Named services with HTTPS inside the tailnet (ADR-0030).
2. Public exposure of selected services (ADR-0031).
3. Federation traffic between collectives (ADR-0033). The coordinator stack has
   no data plane between instances today, so federation links carry no
   traffic.

Off-the-shelf options exist. The `caddy-tailscale` plugin embeds the Tailscale
Go client (`tsnet`) in Caddy. Federation relay halves (ADR-0020) run the
official `tailscale/tailscale` image. Both add a dependency on Tailscale code
for a core feature. The project goal is a self-contained implementation that
stays compatible with Tailscale clients on user devices.

## Decision

Build a gateway node in Rust: crate `coord-gateway`, run by `coord-server` or as
a sibling binary in the coordinator stack. No Tailscale code. Primitive crates
only (WireGuard crypto, a userspace TCP/IP stack, TLS).

### Membership

- The coordinator registers the gateway directly in each tailnet that needs it.
  The gateway does not use an auth key.
- The gateway is a tagged node (`tag:gateway`). It is not owned by a member.
- The gateway is only a client inside the tailnet. It accepts connections on its
  tailnet address. It opens connections only to registered `device:port`
  targets (ADR-0030). It never forwards other traffic.

### Data plane

- WireGuard peer (Noise IKpsk2 plus transport), compatible with Tailscale
  clients.
- Disco (path discovery: ping, pong, call-me-maybe) so that clients find direct
  paths to the gateway. Without disco, clients use the relay.
- DERP client to the built-in relay (ADR-0027) for devices behind NAT.
- One userspace TCP/IP stack per tailnet. All tailnets use the same 100.64.0.0/10
  space, so the stacks must be isolated. One process serves many tailnets, with
  no container or network namespace per tailnet.

### Identity of callers

The coordinator knows which node has which tailnet address and who owns the
node. The gateway asks the coordinator (in process) to map a source address to
a node and an owner. The gateway gives the identity to services (ADR-0030). No
sign-in is necessary inside the tailnet.

### Phases

1. **Join.** The gateway registers, gets a netmap, answers ping through the
   relay. Acceptance: the Mac pings the gateway.
2. **Direct paths.** Disco works. Acceptance: `tailscale status` shows a direct
   path to the gateway.
3. **TCP.** A userspace stack accepts and opens TCP connections in each tailnet.
   Acceptance: the gateway proxies TCP to a port on the Mac.

## Consequences

- One Rust component serves services, public exposure and federation.
- The work is larger than an off-the-shelf plugin. The main risk is exact
  compatibility of disco and WireGuard timing with real Tailscale clients.
  Integration tests with real clients are mandatory at each phase.
- The WireGuard, disco and DERP client code is reusable for the purpose-built
  client (ADR-0024).
- In coordinator mode this replaces the container relay halves of ADR-0020.
