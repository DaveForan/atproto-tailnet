# ADR-0029: Bespoke gateway node (`coord-gateway`)

**Status:** In Progress
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

## Implementation notes

Built (crate `coord-gateway`, and `coord-api/src/gateway.rs`):

- **Membership.** When a tailnet gets its first HTTPS service, the coordinator
  registers a gateway node in it: hostname `gateway`, tag `tag:gateway`, no
  owner, no auth key. Its keys are derived from one gateway secret
  (`gateway.key`) and the tenant ID, so they are the same after a restart and
  no key is in the database.
- **Data plane.** WireGuard with the `boringtun` crate (the protocol state
  machine only). One session for each device. The gateway accepts a decrypted
  packet only when its source address is the tailnet address of the sender.
- **Relay.** The gateway is a client of the built-in relay in the same process
  (`DerpServer::attach_local`). No DERP client over the network is necessary.
  Without direct paths (see phase 2 below), the gateway needs no public UDP
  port.
- **TCP/IP.** One `smoltcp` stack for each tailnet (`netstack.rs`). TCP
  connections are async byte streams.
- **Identity.** The gateway asks the store which node has the source address,
  and the identity registry for the sign-in name of its owner.

Differences from the decision:

- **Disco is not answered by default.** The gateway advertises a disco key,
  because a Tailscale client ignores a peer without one. Without the phase 2
  configuration below, it does not answer disco messages. Devices then always
  reach the gateway through the relay. Traffic to services goes device →
  relay → gateway, in the same process as the relay, so the cost is small.
- The gateway is in the `coord-server` process, not a sibling binary. It needs
  the relay of its process: run it on one replica that serves the relay role.
- The gateway does not appear in device lists and does not count for the
  device limit of a tailnet.

Tests: TCP through WireGuard and the relay between three emulated devices;
refusal of a key that is not a device of the tailnet; refusal of a spoofed
source address; the gateway inside the coordinator with real netmaps.

### Phase 2: direct paths

Phase 2 is built and is off by default. `COORD_GATEWAY_UDP_LISTEN` turns it on
for a relay process that runs gateways. `COORD_GATEWAY_ENDPOINTS` gives the
public addresses of the socket.

- **One socket.** One UDP socket serves the gateways of all tailnets of the
  process (`direct.rs`). The socket sends nothing by itself. It finds the
  gateway for a packet, and the gateway decides.
- **Disco.** The packet format is that of the Tailscale client: a 6-byte
  magic, the disco key of the sender, a 24-byte nonce, and a NaCl box
  (`crypto_box`, a primitive crate). `disco.rs` reads ping, pong and
  call-me-maybe, and writes pong. The gateway sends no ping and no
  call-me-maybe: its address is public, so the ping of the device opens the
  path.
- **Who gets a pong.** Only a disco key of a device in the same tailnet that
  is a peer of the gateway. A ping on UDP must also carry the node key of that
  device. Such a ping is longer than its pong, so the gateway cannot amplify
  traffic to a forged source address. A ping through the relay gets its pong
  through the relay.
- **Finding the gateway for a packet.** Disco: by the disco key of the sender,
  from a list that each gateway gives to the socket and renews when a device
  changes. WireGuard data, handshake response and cookie reply: by the
  receiver index, which is unique on the socket. A WireGuard handshake
  initiation names no receiver: the socket accepts it only from an address
  that sent a valid ping in the last 120 seconds. The gateway then reads the
  key of the sender from the handshake.
- **Limits.** Disco and handshake packets have a rate limit for each source
  address (50 each second). Each device has a rate limit for pongs. All tables
  have a maximum size. A packet that fails a check gets no answer.
- **Path choice.** The gateway sends to a device on the path of the last
  authenticated WireGuard packet from that device. If a direct path is silent
  for 15 seconds, the gateway sends through the relay. It accepts packets on
  the two paths at all times. A device that moves to a new address continues
  without a new ping.
- **Endpoints.** The relay process puts its endpoints in the gateway offer
  (`coord_gateway_offers.endpoints`). The control process writes them to the
  gateway node, and registers the node again when they change. Devices get
  them in the netmap.

Tests for phase 2: disco wire vectors, and a box from an independent NaCl
implementation; routing and limits of the shared socket; a test device that
pings the gateway on UDP, completes WireGuard on UDP with no relay connection,
gets an HTTPS answer, and then moves to another address; refusal of unknown
disco keys, devices of other tailnets, pings without a node key, and
handshakes from an address without a valid ping.

Not confirmed with a real client: that the client selects the direct path
after the pong and shows it in `tailscale status`; the source address in a
pong that goes through the relay (`127.3.3.40` with the region as the port);
that a client never sends a handshake initiation to an address before it gets
a pong from that address.

Not yet done: a test with real Tailscale clients. This is the main risk of
this ADR: the WireGuard timing and the peer rules of the real client (disco
key, home relay) are only known from the client source, not from a run.
