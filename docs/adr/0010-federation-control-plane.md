# ADR-0010: Federation control plane

**Status:** In Progress
**Date:** 2026-11-02
**Priority:** P0
**Depends On:** ADR-0006 (custom DERP relays), ADR-0009 (hierarchical tenancy)

## Context

Federation between tailnets works only at the management layer today.
ADR-0007 introduced a `federation_links` table. The table records
bidirectional trust relationships, and each side declares the CIDR ranges
that it shares. But the table stores intent, not connectivity. Actual
cross-network traffic needs a device that connects to both Headscale
instances (a dual-homed node). This design is fragile and operationally
opaque. It also cannot be gated by policy.

The vision of the project is an "internet of internets". These are
hierarchical, federated private networks. People cross collective
boundaries and carry a portable AT Protocol identity. ADR-0009 introduces
hierarchical tenancy (parent/child collectives). This ADR addresses the next
layer: a purpose-built control plane that coordinates federation at the
WireGuard and protocol level. It removes the dual-homed device workaround.

### Requirements

1. Collectives discover and authenticate each other. After the first
   federation request, no out-of-band coordination is necessary.
2. Route advertisements cross federation boundaries. Traversal policy
   (ADR-0011) applies at every hop.
3. WireGuard peers in separate Headscale instances communicate through
   relay nodes that the broker manages. The relay nodes register in both
   instances. End-user devices do not register in the remote instance.
4. Routes cascade through the hierarchy (child -> parent -> federated peer).
   Policy filters apply at each boundary.
5. DNS resolution works across federation boundaries for published services.

## Decision

We build a **Federation Control Plane (FCP)** as a separate service layer
above the individual Headscale instances. The FCP has six components.

### 1. Federation Broker

A long-running process at the boundary of each collective. It runs as a
sidecar to the Headscale container, or as a standalone process for
multi-instance collectives. The broker does these tasks:

- It advertises exportable route prefixes to peers (filtered by traversal
  policy).
- It negotiates the protocol-level handshake when a management-layer link
  changes to `active`.
- It sends keepalives and route withdrawals.
- For parent collectives, it aggregates child routes for re-advertisement.

The broker exposes a gRPC API for the orchestrator. It also exposes an
internal pub/sub channel (NATS or Redis Streams) for broker-to-broker
coordination.

### 2. Peer Discovery Protocol

Collectives discover and authenticate each other. They use AT Protocol DIDs
as trust anchors.

- Each collective has a **collective DID** that uses `did:web` (it resolves
  to the domain of the platform instance). The system registers it at
  provisioning time. AT Proto does not support organizational accounts.
  The `did:plc` method needs Bluesky PDS infrastructure, so we do not use
  it for collectives. The DID document advertises the broker endpoint in a
  `#federationBroker` service entry. PDS-based features (federation offers,
  relay discovery) are future and optional. Core federation does not need
  them.
- **Key custody**: the platform service (the atproto-tailnet instance)
  holds the private key of the collective DID. No individual user holds it.
  The system stores the key material encrypted in the database and decrypts
  it at runtime. The originator can start a key rotation. When the
  originator changes, the new originator inherits key management (the
  platform holds the key, not the person). For self-hosted instances, the
  instance operator holds the key.
- The collective signs federation requests (modeled in `federation_links`)
  with its keypair. The target verifies the signature against the DID
  document before it accepts the request.
- Active links: both brokers periodically resolve the DID documents of
  each other again. This detects endpoint changes and key rotation.
- New peer discovery: collectives publish `app.tailnet.federation.offer`
  lexicon records to their PDS. Other collectives discover them through
  AT Protocol relay subscription. (This needs a future PDS integration.
  Initial federation does not need it.)

This design reuses AT Proto infrastructure. We do not build a custom PKI.
DID-based trust lets any third party verify federation offers.

### 3. Route Propagation

Routes propagate in both directions. Policy enforcement applies at every
boundary.

- **Export policy**: extends `requestorCidrs`/`targetCidrs` in
  `federation_links` with a richer model (prefix lists, community tags,
  time-of-day constraints, defined in ADR-0011).
- **Import filtering**: the receiving broker applies its own import policy
  before it installs remote routes in the local Headscale route table.
- **Hierarchical cascade**: child -> parent -> federated peer. This mirrors
  the BGP customer -> provider -> peer model. The parent aggregates child
  routes and applies its own export policy before it advertises them again.
- **Loop prevention**: each route carries an `as-path`-style collective
  chain. Brokers reject routes when the chain already contains their own DID.
- **Convergence**: broker-to-broker gRPC streams carry a full table sync
  when the session starts. After that, they carry incremental updates.
  Target: < 30s for a single federation hop.

### 4. Key Exchange Bridge

WireGuard peers in different Headscale instances need encrypted tunnels.

| Approach | Latency | Complexity | NAT traversal |
|----------|---------|------------|---------------|
| **DERP relay bridge** | Higher (relay hop) | Low | Trivial |
| **Direct peer-to-peer** | Lowest | High | Difficult |
| **Hybrid** | Adaptive | Medium | Graceful degradation |

**Decision: hybrid.** DERP relay bridging is the default. Direct
peer-to-peer is the choice when both endpoints are reachable.

- **Relay nodes**: federation uses dedicated **relay nodes**. These are
  lightweight WireGuard peers (containers or long-lived processes). The
  federation broker provisions them and registers them as devices in BOTH
  Headscale instances. Each relay node has a valid registration on each
  side and bridges traffic between the two networks. This is how
  cross-network routing works with Headscale today. Headscale has no API to
  inject arbitrary WireGuard peers without node registration. Traffic flow
  for relayed connections: peer A -> A's DERP -> relay node -> B's DERP ->
  peer B. The relay node is the bridge. The DERP servers are not the bridge,
  because DERP servers in separate Headscale instances have no mechanism
  for inter-DERP bridging. The broker manages the lifecycle of the relay
  nodes: provisioning, registration, health monitoring, and teardown when
  the link is revoked.
- **Direct path upgrade**: after the relayed session starts, peers try a
  direct WireGuard handshake. They use endpoints that they exchange through
  the broker (similar to the direct connection upgrade in Tailscale).
- **Key exchange**: the broker is the intermediary for the WireGuard public
  key exchange. It uses the authenticated gRPC channel. Relay nodes
  register in both Headscale instances as normal devices. The broker
  coordinates their provisioning and the distribution of key material.

### 5. Federation Registry

A distributed registry for collective identity, federation offers, and
network metadata. We build it on AT Protocol. We do not build a custom DHT.

- **Collective profile**: a lexicon record (`app.tailnet.collective.profile`)
  on the PDS of the collective. It contains the DID, the display name, the
  federation posture (open/selective/closed), and the supported protocol
  version.
- **Federation offers**: a lexicon record that the collective publishes when
  it is open to peering. It contains the acceptable terms, the geographic
  scope, and the hierarchy level.
- **Search**: the relay network indexes these records. The service provides
  a search UI. Users can filter by compatibility, geography, and policy.

### 6. Split-Horizon DNS

Each collective has its own namespace (`*.collective-slug.tailnet`).
Federated access resolves across boundaries through the FCP.

- The broker runs a DNS forwarder. The forwarder intercepts queries for
  federated namespaces and proxies them to the correct remote broker.
- Policy gates resolution. A query resolves only if the querying collective
  has an active federation link and traversal policy permits it.
- MagicDNS integration: the broker writes forwarding rules in the DNS
  configuration of Headscale when the link activates. It removes them when
  the link is revoked.

## Consequences

- **New service**: `federation-broker` ships as a sidecar to each Headscale
  instance. Standalone deployment for multi-instance collectives is a later
  optimization.
- **Protocol design prerequisite**: the broker-to-broker gRPC protocol, the
  route format, and the key exchange flow need a formal specification
  before implementation (tracked as ADR-0014).
- **Relay nodes become the critical path**: cross-network traffic uses
  relay nodes that bridge both Headscale instances by default. Relay node
  health monitoring, redundancy, and DERP availability on both sides change
  from optional to required.
- **Trust model**: collective `did:web` DIDs are the root of trust. The
  platform service holds the private keys (encrypted at rest, decrypted at
  runtime). If an attacker compromises the signing key, the attacker can
  impersonate the collective. The originator can start a key rotation. For
  self-hosted instances, the operator can rotate the key.
- **Latency**: each relay node hop adds 10-50ms to cross-network traffic.
  Direct peering upgrades reduce this delay for long-lived flows.
- **Schema migration**: `federation_links` gains columns for broker
  endpoints, protocol version, and route table metadata. The existing fields
  stay as the intent layer that the FCP uses.
- **Operational complexity**: to debug federation, engineers need visibility
  into broker sessions, route tables, and key exchange state. A federation
  health dashboard and structured broker logs are implementation
  requirements.
- **Deeper AT Proto dependency**: the registry and discovery assume a
  functioning relay network. If the relay network is unavailable, discovery
  falls back to manual endpoint exchange (the current model). Runtime
  traffic is not affected.
