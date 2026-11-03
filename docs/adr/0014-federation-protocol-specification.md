# ADR-0014: Federation protocol specification

**Status:** Implemented
**Date:** 2026-11-02
**Priority:** P0
**Depends On:** ADR-0010 (federation control plane), ADR-0011 (traversal policy engine)

## Context

ADR-0010 defines the Federation Control Plane — a broker service, route
propagation model, key exchange bridge, and discovery registry — but leaves
the broker-to-broker wire protocol unspecified. Its consequences section
explicitly calls out this gap: "the broker-to-broker gRPC protocol, route
update format, and key exchange flow require a formal specification before
implementation begins (tracked as ADR-0014)."

A well-defined protocol is the difference between two known services calling
each other's APIs and an open federation where arbitrary collectives can
discover, negotiate, and maintain relationships without prior coordination.
The protocol must be discoverable, negotiable, and revocable.

Precedent exists in adjacent domains: BGP exchanges routes between autonomous
systems, ActivityPub federates social graphs, AT Proto's relay protocol
syndicates repository data. This ADR defines the **Collective Federation
Protocol (CFP)** — the analogous protocol for private network federation,
purpose-built for the trust model and traversal semantics of atproto-tailnet.

## Decision

### 1. Discovery

Collectives publish a signed JSON federation descriptor at
`/.well-known/collective-federation` (mirroring AT Proto's
`.well-known/atproto-did` pattern). The descriptor contains: collective DID
(trust anchor), supported CFP versions (semver), federation policy (`open` /
`selective` / `closed`), supported capabilities (`route-exchange`,
`dns-forward`, `transit`, `mesh`), DERP relay endpoints, broker gRPC URL,
and a detached JWS signature from the collective's AT Proto key.

For collectives without public endpoints, discovery falls back to the
federation registry (ADR-0010 section 5) — the collective publishes an
`app.tailnet.federation.offer` lexicon record to its PDS, discoverable
through the AT Protocol relay network. Additionally, the collective's DID
document may include a `#federationBroker` service entry for programmatic
AT Proto integration.

**Discovery precedence**: `.well-known/collective-federation` is the
**primary** discovery mechanism — it is under the collective's direct
control. The DID document `#federationBroker` entry is secondary, for
programmatic/AT Proto integration. If both exist and conflict,
`.well-known` is authoritative. Collectives SHOULD keep both consistent;
implementations MUST check `.well-known` first and fall back to the DID
document entry only when `.well-known` is unreachable.

### 2. Handshake (4-phase)

Federation establishment follows a four-phase handshake over the broker's
gRPC channel. Every message is signed with the sender's AT Proto key.

**HELLO**: The initiator sends its collective DID, requested federation type,
offered CIDRs and capabilities, and protocol version preference.

**CHALLENGE**: The responder verifies the HELLO signature against the
initiator's DID document, evaluates the request against traversal policy
(ADR-0011), and returns a cryptographic challenge (nonce + timestamp;
expiry is configurable, default 120 seconds, max 600 seconds, negotiated
during HELLO), its own terms (acceptable types, CIDRs, capabilities), and
the negotiated protocol version. Policy denial terminates the handshake here.

The TPE operates at **two levels** during federation: **collective-level**
for the federation handshake itself (using collective DIDs — a
`collective-identity` rule type added to ADR-0011), and **user-level** for
individual traversals once the link is established. The CHALLENGE phase
invokes TPE with the `collective-identity` rule type to evaluate whether
the initiating collective is permitted to federate.

**COMMIT**: The initiator signs the challenge, confirming acceptance of the
negotiated terms, and includes an initial route table snapshot.

**ESTABLISHED**: The responder validates the commitment, returns a session
UUID (used for all subsequent messages), its own route snapshot, and the
agreed keepalive interval. The link transitions to `active` in both brokers.

No routes are installed until phase 4 completes. A failed handshake at any
phase is logged with the full message trace for audit.

### 3. Federation types

- **`peer`** — bilateral, equal standing. Routes exported and imported
  symmetrically. Neither side has policy authority. Default type.
- **`parent-child`** — hierarchical. Parent sets floor/ceiling policies
  (ADR-0011) the child must enforce. Child routes cascade upward.
- **`transit`** — one collective forwards traffic to reach a third, like BGP
  transit. Requires explicit opt-in from the transit provider's policy.
- **`mesh`** — multi-party agreement. Implemented as bilateral `peer` links
  with a shared mesh identifier and synchronized policy.

### 4. Route exchange

After session establishment, brokers exchange route updates over the
persistent gRPC stream:

- **Announcements**: prefixes with attributes (origin DID, path vector,
  community tags, preference). Full sync at session start; incremental
  updates thereafter.
- **Loop prevention**: each route carries a path vector of collective DIDs
  (analogous to BGP AS-PATH). Routes containing the receiver's own DID are
  rejected.
- **Policy filtering**: every route passes through the traversal policy
  engine (ADR-0011) at both export and import boundaries. Failed routes are
  silently dropped.
- **Origin authentication**: each route announcement includes a detached
  signature from the originating collective's DID key. Receiving brokers
  verify that the announcing collective is the legitimate origin or holds
  a signed transit delegation from the origin. This prevents route
  hijacking within an otherwise-agreed federation scope.
- **Withdrawal**: explicit withdrawal messages when prefixes become
  unreachable or policy revokes them. Withdrawals propagate transitively.
- **Convergence**: < 5 seconds per hop for incremental updates; < 30 seconds
  end-to-end for a 3-hop topology change.

### 5. Keepalive and health

Both brokers send `KEEPALIVE` at a negotiated interval (default 60s, range
10-300s). Three consecutive misses mark the session `degraded` (broker
probes at 5s intervals). Five misses or TCP disconnect marks it `down` —
all routes from the failed peer are withdrawn immediately. The initiating
side reconnects with exponential backoff (1s to 5m cap), re-running the
full handshake with DID and policy re-verification.

### 6. Revocation

- **Graceful**: either side sends `REVOKE` with an optional reason. The peer
  has a 30-second drain period, then routes are withdrawn and the session
  torn down.
- **Ungraceful**: detected by heartbeat failure. Routes withdrawn immediately
  with no drain. Link transitions to `down`, then `revoked` after backoff
  exhaustion.
- **Permanent vs. temporary**: `REVOKE` includes a `permanent` flag.
  Temporary preserves the link record for re-establishment; permanent
  deletes shared state and requires a fresh handshake.

### 7. Wire format and versioning

- **Transport**: HTTPS + JSON for discovery and handshake (low-frequency,
  human-debuggable); gRPC + Protobuf for high-frequency route exchange and
  keepalive (compact, streaming-native). Broker-to-broker gRPC uses TLS
  (mutual TLS where available, AT Proto key signatures as fallback
  authentication).
- **Signing**: every message carries a detached JWS verifiable against the
  sender's DID document. Unsigned messages are rejected.
- **Message size limit**: 1MB maximum per message. Route table snapshots
  exceeding 1MB must be paginated across multiple messages with a
  continuation token.
- **Versioning**: semver. HELLO/CHALLENGE negotiates the highest mutually
  supported version. Breaking changes require a major bump. Brokers must
  support at least current minus one for graceful rollout.

### 8. Security considerations

- **Handshake spam**: rate limiting by collective DID (10 HELLO per DID per
  minute), not source IP (which fails through DERP relays where many
  collectives share an IP). Each HELLO is signed, so the DID is
  authenticated before rate-limit accounting. Duplicate DIDs from the same
  source are rate-limited regardless of IP. Optional hashcash-style
  proof-of-work on HELLO (adjustable difficulty) as an additional layer.
- **DID spoofing**: signatures verified against DID documents; mitigated by
  short-TTL caching and PLC directory cross-reference for `did:plc`.
- **Route injection**: routes outside the federation link's agreed CIDR scope
  are rejected at import.
- **NAT traversal**: DERP relays (ADR-0006, ADR-0010) as fallback. The
  protocol treats relayed and direct connections identically at the message
  layer.

## Consequences

- **Formal specification needed**: this ADR captures the design; an RFC-style
  document with message schemas, state machine diagrams, and error codes is
  a separate deliverable.
- **Reference implementation**: the `federation-broker` service (ADR-0010)
  implements CFP. The handshake state machine, route exchange engine, and
  keepalive logic are its core modules.
- **Interoperability testing**: a conformance suite covering handshake edge
  cases, route exchange correctness, and failure modes is required before
  third-party implementations can be trusted.
- **Rolling upgrades**: version negotiation plus one-version-back support
  means federated collectives can upgrade independently without coordinated
  deployment windows.
- **Operational visibility**: long-lived stateful sessions require first-class
  tooling — session state, route tables, heartbeat status, and handshake
  history in the broker admin API and federation dashboard.
- **DoS surface**: the internet-facing gRPC endpoint must be monitored and
  hardened. Rate limiting and proof-of-work mitigate handshake spam but do
  not eliminate the attack surface.
