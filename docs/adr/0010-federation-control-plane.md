# ADR-0010: Federation control plane

**Status:** In Progress
**Date:** 2026-11-02
**Priority:** P0
**Depends On:** ADR-0006 (custom DERP relays), ADR-0009 (hierarchical tenancy)

## Context

Federation between tailnets today is management-layer only. ADR-0007
introduced a `federation_links` table that records bidirectional trust
relationships — each side declares which CIDR ranges it shares — but the
table stores intent, not connectivity. Actual cross-network traffic requires
a device straddling both Headscale instances (dual-homed node), which is
fragile, operationally opaque, and impossible to policy-gate.

The project's vision is an "internet of internets" — hierarchical, federated
private networks where people traverse collective boundaries carrying
portable AT Protocol identity. ADR-0009 introduces hierarchical tenancy
(parent/child collectives). This ADR addresses the next layer: a purpose-
built control plane that coordinates federation at the WireGuard/protocol
level, eliminating the dual-homed device hack.

### Requirements

1. Collectives discover and authenticate each other without out-of-band
   coordination beyond the initial federation request.
2. Route advertisements flow across federation boundaries, subject to
   traversal policy (ADR-0011) at every hop.
3. WireGuard peers in separate Headscale instances communicate via
   broker-managed relay nodes registered in both instances, without
   end-user devices registering in the remote instance.
4. Routes cascade through hierarchy (child -> parent -> federated peer) with
   policy filters at each boundary.
5. DNS resolution works across federation boundaries for published services.

## Decision

Build a **Federation Control Plane (FCP)** as a distinct service layer above
individual Headscale instances. The FCP has six components.

### 1. Federation Broker

A long-running process at each collective's boundary — sidecar to the
Headscale container, or standalone for multi-instance collectives. It
advertises exportable route prefixes to peers (filtered by traversal
policy), negotiates the protocol-level handshake when a management-layer
link transitions to `active`, sends keepalives and route withdrawals, and
for parent collectives, aggregates child routes for re-advertisement.

The broker exposes a gRPC API for the orchestrator and an internal pub/sub
channel (NATS or Redis Streams) for broker-to-broker coordination.

### 2. Peer Discovery Protocol

Collectives discover and authenticate each other using AT Protocol DIDs as
trust anchors.

- Each collective has a **collective DID** using `did:web` (resolving to
  the platform instance's domain), registered at provisioning time. AT Proto
  does not support organizational accounts, so `did:plc` (which requires
  Bluesky PDS infrastructure) is not used for collectives. The DID document
  advertises the broker endpoint in a `#federationBroker` service entry.
  PDS-based features (federation offers, relay discovery) are future/optional
  and not required for core federation.
- **Key custody**: the collective DID private key is held by the platform
  service (the atproto-tailnet instance), not by any individual user. Key
  material is stored encrypted in the database and decrypted at runtime.
  The originator can trigger key rotation. On originator change, the new
  originator inherits key management (the platform holds the key, not the
  person). For self-hosted instances, the instance operator holds the key.
- Federation requests (modeled in `federation_links`) are signed with the
  collective's keypair. The target verifies the signature against the DID
  document before accepting.
- Active links: both brokers periodically re-resolve each other's DID
  documents to detect endpoint changes or key rotation.
- New peer discovery: collectives publish `app.tailnet.federation.offer`
  lexicon records to their PDS, discoverable via AT Protocol relay
  subscription. (Requires future PDS integration; not needed for initial
  federation.)

This reuses AT Proto infrastructure rather than building custom PKI. DID-
based trust means federation offers are verifiable by any third party.

### 3. Route Propagation

Routes propagate bidirectionally with policy enforcement at every boundary.

- **Export policy**: extends `requestorCidrs`/`targetCidrs` in
  `federation_links` with a richer model (prefix lists, community tags,
  time-of-day constraints — defined in ADR-0011).
- **Import filtering**: the receiving broker applies its own import policy
  before installing remote routes into the local Headscale route table.
- **Hierarchical cascade**: child -> parent -> federated peer, mirroring
  BGP's customer -> provider -> peer model. The parent aggregates child
  routes and applies its own export policy before re-advertising.
- **Loop prevention**: each route carries an `as-path`-style collective
  chain. Brokers reject routes whose chain already contains their own DID.
- **Convergence**: broker-to-broker gRPC streams carry full table sync on
  session establishment, incremental updates thereafter. Target: < 30s for
  a single federation hop.

### 4. Key Exchange Bridge

WireGuard peers in different Headscale instances need encrypted tunnels.

| Approach | Latency | Complexity | NAT traversal |
|----------|---------|------------|---------------|
| **DERP relay bridge** | Higher (relay hop) | Low | Trivial |
| **Direct peer-to-peer** | Lowest | High | Difficult |
| **Hybrid** | Adaptive | Medium | Graceful degradation |

**Decision: hybrid.** DERP relay bridging as the default; direct peer-to-
peer when both endpoints are reachable.

- **Relay nodes**: federation uses dedicated **relay nodes** — lightweight
  WireGuard peers (containers or long-lived processes) that the federation
  broker provisions and registers as devices in BOTH Headscale instances.
  Each relay node holds valid registrations on each side and bridges
  traffic between the two networks. This is how cross-network routing
  works with Headscale today; there is no API to inject arbitrary
  WireGuard peers without node registration. Traffic flow for relayed
  connections: peer A -> A's DERP -> relay node -> B's DERP -> peer B.
  The relay node is the bridge, not the DERP servers themselves (DERP
  servers in separate Headscale instances have no inter-DERP bridging
  mechanism). The broker manages relay node lifecycle: provisioning,
  registration, health monitoring, and teardown on link revocation.
- **Direct path upgrade**: after the relayed session is established, peers
  attempt a direct WireGuard handshake via endpoints exchanged through the
  broker (analogous to Tailscale's direct connection upgrade).
- **Key exchange**: the broker acts as intermediary for WireGuard public key
  exchange over the authenticated gRPC channel. Relay nodes register in
  both Headscale instances as normal devices; the broker coordinates their
  provisioning and key material distribution.

### 5. Federation Registry

A distributed registry for collective identity, federation offers, and
network metadata — built on AT Protocol rather than a custom DHT.

- **Collective profile**: lexicon record (`app.tailnet.collective.profile`)
  on the collective's PDS. Contains DID, display name, federation posture
  (open/selective/closed), and supported protocol version.
- **Federation offers**: lexicon record published when a collective is open
  to peering. Contains acceptable terms, geographic scope, hierarchy level.
- **Search**: the relay network indexes these records. The service provides
  a search UI filtering by compatibility, geography, and policy.

### 6. Split-Horizon DNS

Each collective has its own namespace (`*.collective-slug.tailnet`).
Federated access resolves across boundaries through the FCP.

- The broker runs a DNS forwarder that intercepts queries for federated
  namespaces and proxies them to the appropriate remote broker.
- Resolution is policy-gated: queries only resolve if the querying
  collective has an active federation link and traversal policy permits it.
- MagicDNS integration: the broker writes forwarding rules into Headscale's
  DNS configuration on link activation and removes them on revocation.

## Consequences

- **New service**: `federation-broker` ships as a sidecar to each Headscale
  instance. Standalone deployment for multi-instance collectives is a later
  optimization.
- **Protocol design prerequisite**: the broker-to-broker gRPC protocol,
  route format, and key exchange flow need formal specification before
  implementation (tracked as ADR-0014).
- **Relay nodes become critical path**: cross-network traffic defaults to
  relay nodes bridging both Headscale instances. Relay node health
  monitoring, redundancy, and DERP availability on both sides are promoted
  from optional to required.
- **Trust model**: collective `did:web` DIDs are the root of trust, with
  private keys held by the platform service (encrypted at rest, decrypted
  at runtime). Signing key compromise allows impersonation — the originator
  can trigger key rotation, and operator-level key rotation is available
  for self-hosted instances.
- **Latency**: cross-network hops add 10-50ms per relay node hop. Direct
  peering upgrades mitigate this for long-lived flows.
- **Schema migration**: `federation_links` gains columns for broker
  endpoints, protocol version, and route table metadata. Existing fields
  are preserved as the intent layer the FCP acts upon.
- **Operational complexity**: federation debugging requires visibility into
  broker sessions, route tables, and key exchange state. A federation
  health dashboard and structured broker logs are implementation
  requirements.
- **AT Proto dependency deepens**: registry and discovery assume a
  functioning relay network. If unavailable, discovery degrades to manual
  endpoint exchange (the current model). Runtime traffic is unaffected.
