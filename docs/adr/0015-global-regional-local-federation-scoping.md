# ADR-0015: Global / regional / local federation scoping

**Status:** Implemented
**Date:** 2026-11-02
**Priority:** P1
**Depends On:** ADR-0012 (credential bundles), ADR-0014 (federation protocol specification)

## Context

Not all federation is equal. The atproto-tailnet federation model (ADR-0010,
ADR-0014) treats every link between collectives the same way. It uses the same
handshake, the same verification, and the same routing assumptions. In
practice, federation happens at very different scales. Each scale has its own
physical, trust, and governance characteristics.

A local mesh of collectives on a university campus shares a LAN. Packets
between them cross zero hops, the latency is below one millisecond, and the
administrators know each other by name. Trust is high and ceremony must be low.
At the other extreme, a global federation links collectives in Berlin,
Nairobi, and Sao Paulo. It crosses continents and adds hundreds of milliseconds
of latency. It connects communities that have no prior relationship. Trust must
be earned, verification must be thorough, and relay infrastructure must know
geography.

The system currently has no concept of proximity. Every federation link pays
the same verification cost, whether the peer is across the hall or across the
ocean. Discovery is one mechanism that gives nearby collectives no advantage.
DERP relay selection ignores geography. The system does not define governance
expectations (who coordinates, who arbitrates disputes) at any scale.

Without scope awareness, the network cannot optimize routing for nearby peers.
It cannot offer lighter onboarding for trusted local partners. It cannot guide
communities toward governance models that fit their actual topology.

## Decision

### Three-tier federation scoping

We tag every federation link with one of three scopes. The scope describes the
operational context of the link. The participating collectives declare the
scope. The system does not infer it. A scope is a statement of intent, not a
measurement.

#### Local scope

Collectives on the same physical network, datacenter, campus, or city.

- **Connectivity**: Direct WireGuard peering is preferred. Peers do not need a
  DERP relay when they share a LAN or can punch through local NATs. A
  co-located DERP relay serves as fallback.
- **Trust default**: Highest. Local collectives use the **same** 4-phase
  federation handshake (ADR-0014) but with permissive default policies. The
  TPE still evaluates every federation request (the deny-all default stands).
  Local scope collectives can set permissive policy rules (for example,
  `allow all from scope:local`) that cause auto-acceptance. The protocol is the
  same. The **policy** is different.
- **Use cases**: Office departments, campus research labs, neighborhood mesh
  networks, maker spaces, co-working buildings.
- **Discovery**: mDNS/DNS-SD broadcast on the local network, and well-known
  HTTPS endpoints (for example, `/.well-known/atproto-tailnet`) on local DNS.
  Collectives announce their presence and scope automatically.
  **Important**: mDNS is for **discovery only**. It does not establish trust.
  After mDNS discovery, the full federation handshake (ADR-0014) still runs,
  including DID verification and challenge-response. The CHALLENGE phase
  rejects a spoofed mDNS announcement when DID verification fails.

#### Regional scope

Collectives in a geographic, cultural, or organizational region.

- **Connectivity**: DERP relays in the region handle NAT traversal. The
  collectives try direct peering first. Regional DERP clusters serve as
  fallback. The latency budget is single-digit to low double-digit
  milliseconds.
- **Trust default**: Moderate. The standard federation handshake (ADR-0014) is
  required. The verifier checks credential bundles (ADR-0012) normally.
- **Use cases**: City-wide collective meshes, industry consortiums, cultural or
  linguistic communities, regional ISP cooperatives, municipal digital
  infrastructure.
- **Discovery**: Regional federation registries. A coordinating collective
  self-hosts a registry, or the registry is published through the AT Proto
  relay. Collectives register with a region tag and appear in regional
  directory queries.

#### Global scope

Collectives that span multiple regions or continents.

- **Connectivity**: DERP relays are required. Peers with no shared relay region
  can use multi-hop relay paths. Geo-distributed DERP nodes with anycast
  routing minimize latency.
- **Trust default**: Lowest. Full verification is required. This means a
  complete credential bundle check and capability tokens with short TTLs.
  Initial federation establishment can also use optional proof-of-work or
  proof-of-stake challenges.
- **Use cases**: International organizations, diaspora communities, global
  open-source projects, cross-border research collaborations.
- **Discovery**: Well-known federation registries (HTTPS endpoints). Collectives
  register with them voluntarily, analogous to DNS root servers. The AT Proto
  relay network is an additional discovery channel. This approach leans toward
  centralization. The tradeoff is simplicity and auditability over full
  decentralization. We reserve a Kademlia-style DHT for a future iteration,
  after the federation registry model proves insufficient at scale.

### Scope declaration

Each collective declares its scope participation in its federation descriptor
(the signed document that ADR-0014 introduced):

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

- `scopes` — the tiers in which this collective participates. A collective can
  participate in one, two, or all three.
- `region` — the UN M49 geographic region code (3-digit numeric) for regional
  discovery grouping. M49 is well-known, stable, and hierarchical (regions
  contain sub-regions). Collectives can use sub-region codes for finer
  granularity (for example, `"021"` for Northern America and `"419"` for Latin
  America). Collectives can add free-form tags as supplementary labels next to
  the M49 code, but the system does not use them for matching.
- `coordinates` — latitude and longitude for proximity-based local discovery.
  This field is optional. Privacy-sensitive collectives omit it entirely.
- `scope-policies` — per-scope overrides for federation behavior. They map to
  traversal policy engine rules (ADR-0011). `auto-accept: true` means that the
  TPE auto-accepts federation requests that pass evaluation. The TPE still
  runs. The **policy** is permissive, and it does not bypass the engine. A
  collective can auto-accept locally and require manual approval globally.

### DERP topology follows scope

The DERP relay infrastructure (ADR-0006) aligns with the federation scope:

- **Local**: Direct peer-to-peer connections, or a co-located DERP relay on
  the shared network. Collectives can run a local DERP node and offer it to
  local federation peers.
- **Regional**: Regional DERP clusters. A coordinating collective (or more than
  one) in the region operates DERP relays and shares them with regional
  federation partners. Region tags in the scope declaration guide relay
  selection.
- **Global**: Geo-distributed DERP with anycast. Multiple DERP nodes across
  regions route each client to the nearest node. The system uses multi-hop
  relay paths when the source and the destination have no shared DERP region.

A collective that runs DERP relays declares them in its federation descriptor
with a scope tag. This makes the relays discoverable to peers at the correct
tier.

### Governance per scope

Scope implies a governance model. The system enforces topology, not politics:

- **Local**: Informal and consensus-based. Participants usually know each
  other. They resolve disputes face-to-face. The scope needs no coordinator
  role.
- **Regional**: The region can have a coordinating collective. It operates
  shared infrastructure (DERP relays, registry) and helps with onboarding.
  Models include hub-spoke and elected coordinator. The coordinator has no
  technical authority. It has only social convention and infrastructure
  control.
- **Global**: Protocol-governed. No single authority exists. Governance emerges
  from the federation protocol itself. Peers defederate collectives that
  violate norms. A central body does not defederate them.

### Routing optimization

We tag routes between collectives with a scope. The routing layer prefers the
narrower scope:

1. **Local** routes are preferred over regional
2. **Regional** routes are preferred over global
3. **Global** routes are the last resort

This is analogous to BGP local preference, but it operates at the collective
hierarchy level. Scope affects routing preference **only when actual latency
data is unavailable**. When measured latency exists (for example, from relay
node probes or WireGuard keepalive RTTs), the system uses the measured latency
for path selection. Scope is a heuristic tiebreaker for paths with no latency
data. It is not a routing override. Two collectives can have multiple paths
with no latency measurements (for example, a local direct link and a global
relay path). In that case, the local path wins by scope preference. Traversal
policies (ADR-0011) can override scope preference for specific cases.

### Scope boundaries are fuzzy

A collective that spans two continents can declare itself regional. A "local"
scope can cover an entire metro area. The system treats scope as a hint, not a
hard boundary:

- Scope is self-declared and not verified. A collective that claims local scope
  but routes through three continents gets poor performance from the
  local-optimized path.
- Peers can disagree on scope. Collective A can consider the link local while
  collective B considers it regional. In that case, the more conservative scope
  (regional) governs trust defaults and verification requirements.
- Scope can change over time. A collective that starts local can expand to
  regional without breaking existing federation links.

## Consequences

- **Federation descriptor gains scope metadata**: The signed federation
  document (ADR-0014) must include `scopes`, optional `region`, optional
  `coordinates`, and `scope-policies`. The schema needs versioning.
- **Three discovery implementations**: mDNS/DNS-SD for local, a registry for
  regional, and well-known federation registries plus the AT Proto relay for
  global. Each has its own protocol, failure modes, and security
  considerations. This is the largest implementation cost.
- **DERP infrastructure needs geographic awareness**: Relay selection must
  consider scope and region. The DERP configuration model (ADR-0006) needs
  scope tags on relay definitions. It also needs a selection algorithm that
  prefers scope-matched relays.
- **Privacy tradeoff on coordinates**: Latitude and longitude in the federation
  descriptor improve local discovery but reveal the physical location. The
  field is optional. Collectives in sensitive contexts should omit it. The
  documentation must state this tradeoff clearly.
- **Governance is social, not technical**: The system can provide tooling
  (coordinator election, shared relay provisioning, regional directory hosting)
  but cannot enforce governance models. Documentation, templates, and community
  guides are as important as code.
- **Graceful degradation on scope mismatch**: The conservative-scope rule
  (when peers disagree, the stricter scope governs) means that no link gets
  less verification than either party expects. One party can get more ceremony
  than it considers necessary.
- **Traversal policy integration**: Scope-aware rules for the TPE (ADR-0011).
  For example, a `scope-match` rule type allows or denies based on the scope of
  the federation link. Floor policies can require a minimum scope verification.
- **Region taxonomy uses UN M49**: The initial taxonomy is UN M49 geographic
  region codes (3-digit numeric, hierarchical). This prevents the fragmentation
  of free-form tags and gives a well-known, stable standard. Free-form
  supplementary labels are allowed, but the system does not use them for
  programmatic matching.
