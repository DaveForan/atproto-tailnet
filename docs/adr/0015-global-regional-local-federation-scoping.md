# ADR-0015: Global / regional / local federation scoping

**Status:** Implemented
**Date:** 2026-11-02
**Priority:** P1
**Depends On:** ADR-0012 (credential bundles), ADR-0014 (federation protocol specification)

## Context

Not all federation is equal. The atproto-tailnet federation model
(ADR-0010, ADR-0014) treats every link between collectives uniformly: same
handshake, same verification, same routing assumptions. In practice,
federation happens at radically different scales, and those scales have
distinct physical, trust, and governance characteristics.

A local mesh of collectives on a university campus shares a LAN. Packets
between them traverse zero hops, latency is sub-millisecond, and the
administrators know each other by name. Trust is high and ceremony should
be low. At the other extreme, a global federation linking collectives in
Berlin, Nairobi, and Sao Paulo crosses continents, accumulates hundreds of
milliseconds of latency, and connects communities with no prior
relationship. Trust must be earned, verification must be thorough, and
relay infrastructure must be geo-aware.

The system currently has no concept of proximity. Every federation link
pays the same verification cost regardless of whether the peer is across
the hall or across the ocean. Discovery is a single mechanism that doesn't
advantage nearby collectives. DERP relay selection ignores geography.
Governance expectations (who coordinates, who arbitrates disputes) are
undefined at every scale.

Without scope awareness, the network cannot optimize routing for nearby
peers, cannot offer lighter onboarding for trusted local partners, and
cannot guide communities toward governance models that fit their actual
topology.

## Decision

### Three-tier federation scoping

Every federation link is tagged with one of three scopes that describe its
operational context. Scope is declared by the participating collectives,
not inferred — it is a statement of intent, not a measurement.

#### Local scope

Collectives on the same physical network, datacenter, campus, or city.

- **Connectivity**: Direct WireGuard peering preferred. No DERP relay
  needed when peers share a LAN or can punch through local NATs. A
  co-located DERP relay serves as fallback.
- **Trust default**: Highest. Local collectives use the **same** 4-phase
  federation handshake (ADR-0014) but with permissive default policies:
  the TPE still evaluates every federation request (the deny-all default
  stands), but local scope collectives can set permissive policy rules
  (e.g., `allow all from scope:local`) that cause auto-acceptance. The
  protocol is the same; the **policy** is different.
- **Use cases**: Office departments, campus research labs, neighborhood
  mesh networks, maker spaces, co-working buildings.
- **Discovery**: mDNS/DNS-SD broadcast on the local network, plus
  well-known HTTPS endpoints (e.g., `/.well-known/atproto-tailnet`) on
  local DNS. Collectives announce presence and scope automatically.
  **Important**: mDNS is for **discovery only**, not trust establishment.
  After mDNS discovery, the full federation handshake (ADR-0014) still
  runs, including DID verification and challenge-response. A spoofed mDNS
  announcement is rejected at the CHALLENGE phase when DID verification
  fails.

#### Regional scope

Collectives within a geographic, cultural, or organizational region.

- **Connectivity**: DERP relays within the region handle NAT traversal.
  Direct peering attempted first; regional DERP clusters serve as
  fallback. Latency budget: single-digit to low double-digit milliseconds.
- **Trust default**: Moderate. Standard federation handshake (ADR-0014)
  required. Credential bundles (ADR-0012) verified normally.
- **Use cases**: City-wide collective meshes, industry consortiums,
  cultural or linguistic communities, regional ISP cooperatives,
  municipal digital infrastructure.
- **Discovery**: Regional federation registries — either self-hosted by a
  coordinating collective or published via AT Proto relay. Collectives
  register with a region tag and appear in regional directory queries.

#### Global scope

Collectives spanning multiple regions or continents.

- **Connectivity**: DERP relays required. Multi-hop relay paths possible
  for peers with no shared relay region. Geo-distributed DERP nodes with
  anycast routing minimize latency.
- **Trust default**: Lowest. Full verification required: complete
  credential bundle check, capability tokens with short TTLs, and
  optional proof-of-work or proof-of-stake challenges for initial
  federation establishment.
- **Use cases**: International organizations, diaspora communities, global
  open-source projects, cross-border research collaborations.
- **Discovery**: A set of well-known federation registries (HTTPS
  endpoints) that collectives register with voluntarily, analogous to DNS
  root servers. The AT Proto relay network serves as an additional
  discovery channel. This is centralization-leaning — the tradeoff is
  simplicity and auditability over full decentralization. A Kademlia-style
  DHT is reserved for a future iteration once the federation registry
  model proves insufficient at scale.

### Scope declaration

Each collective declares its scope participation in its federation
descriptor (the signed document introduced in ADR-0014):

```yaml
federation:
  scopes: [local, regional, global]
  region: "021"                    # UN M49 Northern America
  coordinates: [42.36, -71.06]    # optional, for proximity discovery
  scope-policies:
    local:
      auto-accept: true             # TPE still runs; policy is permissive
      verification: standard        # same ADR-0014 handshake; policy auto-accepts
    regional:
      auto-accept: false
      verification: standard        # full ADR-0014 handshake
    global:
      auto-accept: false
      verification: strict          # full handshake + capability tokens
```

- `scopes` — which tiers this collective participates in. A collective
  may participate in one, two, or all three.
- `region` — UN M49 geographic region code (3-digit numeric) for regional
  discovery grouping. M49 is well-known, stable, and hierarchical (regions
  contain sub-regions). Collectives can use sub-region codes for finer
  granularity (e.g., `"021"` for Northern America, `"419"` for Latin
  America). Free-form tags are allowed as supplementary labels alongside
  the M49 code but are not used for matching.
- `coordinates` — latitude/longitude for proximity-based local discovery.
  Optional. Privacy-sensitive collectives omit this entirely.
- `scope-policies` — per-scope overrides for federation behavior. Maps to
  traversal policy engine rules (ADR-0011). `auto-accept: true` means the
  TPE auto-accepts federation requests that pass evaluation (the TPE still
  runs; it is the **policy** that is permissive, not a bypass of the
  engine). A collective might auto-accept locally but require manual
  approval globally.

### DERP topology follows scope

DERP relay infrastructure (ADR-0006) aligns with federation scope:

- **Local**: Direct peer-to-peer or co-located DERP relay on the shared
  network. Collectives can run a local DERP node and offer it to local
  federation peers.
- **Regional**: Regional DERP clusters. A coordinating collective (or
  several) in the region operates DERP relays and shares them with
  regional federation partners. Region tags in the scope declaration
  guide relay selection.
- **Global**: Geo-distributed DERP with anycast. Multiple DERP nodes
  across regions, with clients routed to the nearest. Multi-hop relay
  paths when source and destination have no shared DERP region.

Collectives that run DERP relays declare them in their federation
descriptor with a scope tag, making them discoverable to peers at the
appropriate tier.

### Governance per scope

Scope implies a governance model, though the system enforces topology, not
politics:

- **Local**: Informal, consensus-based. Participants typically know each
  other. Disputes resolved face-to-face. No coordinator role required.
- **Regional**: May have a coordinating collective that operates shared
  infrastructure (DERP relays, registry) and facilitates onboarding.
  Hub-spoke or elected coordinator models. The coordinator has no
  technical authority — only social convention and infrastructure control.
- **Global**: Protocol-governed. No single authority. Governance is
  emergent from the federation protocol itself: collectives that violate
  norms get defederated by their peers, not by a central body.

### Routing optimization

Routes between collectives are tagged with scope. The routing layer
prefers narrower scope:

1. **Local** routes preferred over regional
2. **Regional** routes preferred over global
3. **Global** routes used as last resort

This is analogous to BGP local preference but operates at the collective
hierarchy level. Scope affects routing preference **only when actual
latency data is unavailable**. When measured latency exists (e.g., from
relay node probes or WireGuard keepalive RTTs), use measured latency for
path selection. Scope is a heuristic tiebreaker for paths with no latency
data, not a routing override. When multiple paths exist between two
collectives with no latency measurements (e.g., a local direct link and a
global relay path), the local path wins by scope preference. Traversal
policies (ADR-0011) can override scope preference for specific cases.

### Scope boundaries are fuzzy

A collective that spans two continents might declare itself regional.
A "local" scope might cover an entire metro area. The system treats scope
as a hint, not a hard boundary:

- Scope is self-declared, not verified. A collective that claims local
  scope but routes through three continents will simply get poor
  performance from the local-optimized path.
- Peers can disagree on scope. If collective A considers the link local
  but collective B considers it regional, the more conservative scope
  (regional) governs trust defaults and verification requirements.
- Scope can change over time. A collective that starts local can expand
  to regional without breaking existing federation links.

## Consequences

- **Federation descriptor gains scope metadata**: The signed federation
  document (ADR-0014) must include `scopes`, optional `region`, optional
  `coordinates`, and `scope-policies`. Schema versioning needed.
- **Three discovery implementations**: mDNS/DNS-SD for local, registry
  for regional, well-known federation registries + AT Proto relay for
  global. Each has its own protocol, failure modes, and security
  considerations. This is the largest implementation cost.
- **DERP infrastructure needs geographic awareness**: Relay selection
  must consider scope and region. The DERP configuration model (ADR-0006)
  needs scope tags on relay definitions and a selection algorithm that
  prefers scope-matched relays.
- **Privacy tradeoff on coordinates**: Latitude/longitude in the
  federation descriptor improves local discovery but reveals physical
  location. The field is optional, and collectives in sensitive contexts
  should omit it. Documentation must make this tradeoff explicit.
- **Governance is social, not technical**: The system can provide
  tooling (coordinator election, shared relay provisioning, regional
  directory hosting) but cannot enforce governance models. Documentation,
  templates, and community guides are as important as code.
- **Graceful degradation on scope mismatch**: The conservative-scope rule
  (when peers disagree, the stricter scope governs) means no link ever
  gets less verification than either party expects, but may get more
  ceremony than one party considers necessary.
- **Traversal policy integration**: Scope-aware rules for the TPE
  (ADR-0011) — e.g., `scope-match` rule type that allows/denies based
  on the federation link's scope. Floor policies can mandate minimum
  scope verification.
- **Region taxonomy uses UN M49**: The initial taxonomy is UN M49 geographic
  region codes (3-digit numeric, hierarchical). This avoids fragmentation
  from free-form tags while providing a well-known, stable standard.
  Free-form supplementary labels are allowed but not used for programmatic
  matching.
