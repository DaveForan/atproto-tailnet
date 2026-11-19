# ADR-0014: Federation protocol specification

**Status:** Implemented
**Date:** 2026-11-02
**Priority:** P0
**Depends On:** ADR-0010 (federation control plane), ADR-0011 (traversal policy engine)

## Context

ADR-0010 defines the Federation Control Plane. It has a broker service, a route
propagation model, a key exchange bridge, and a discovery registry. But it does
not specify the broker-to-broker wire protocol. Its consequences section names
this gap: "the broker-to-broker gRPC protocol, route update format, and key
exchange flow require a formal specification before implementation begins
(tracked as ADR-0014)."

A well-defined protocol separates two types of system. In the first, two known
services call each other's APIs. In the second, an open federation lets
arbitrary collectives discover each other, negotiate, and maintain
relationships without prior coordination. The protocol must be discoverable,
negotiable, and revocable.

Precedent exists in adjacent domains. BGP exchanges routes between autonomous
systems. ActivityPub federates social graphs. The AT Proto relay protocol
syndicates repository data. This ADR defines the **Collective Federation
Protocol (CFP)**. CFP is the analogous protocol for private network
federation. We built it for the trust model and the traversal semantics of
atproto-tailnet.

## Decision

### 1. Discovery

Collectives publish a signed JSON federation descriptor at
`/.well-known/collective-federation`. This mirrors the AT Proto
`.well-known/atproto-did` pattern. The descriptor contains these fields:

- The collective DID (trust anchor)
- The supported CFP versions (semver)
- The federation policy (`open` / `selective` / `closed`)
- The supported capabilities (`route-exchange`, `dns-forward`, `transit`,
  `mesh`)
- The DERP relay endpoints
- The broker gRPC URL
- A detached JWS signature from the AT Proto key of the collective

A collective without public endpoints uses the federation registry for
discovery (ADR-0010 section 5). The collective publishes an
`app.tailnet.federation.offer` lexicon record to its PDS. Peers discover this
record through the AT Protocol relay network. The DID document of the
collective can also include a `#federationBroker` service entry for
programmatic AT Proto integration.

**Discovery precedence**: `.well-known/collective-federation` is the
**primary** discovery mechanism because the collective controls it directly.
The DID document `#federationBroker` entry is secondary, for programmatic and
AT Proto integration. If both exist and conflict, `.well-known` is
authoritative. Collectives should keep both consistent. Implementations MUST
check `.well-known` first. They fall back to the DID document entry only when
`.well-known` is unreachable.

### 2. Handshake (4-phase)

Federation establishment uses a four-phase handshake over the gRPC channel of
the broker. The sender signs every message with its AT Proto key.

**HELLO**: The initiator sends its collective DID, the requested federation
type, the offered CIDRs and capabilities, and its protocol version preference.

**CHALLENGE**: The responder verifies the HELLO signature against the DID
document of the initiator. It evaluates the request against traversal policy
(ADR-0011). Then it returns these items:

- A cryptographic challenge (nonce and timestamp). The expiry is configurable.
  The default is 120 seconds and the maximum is 600 seconds. Both sides
  negotiate it during HELLO.
- Its own terms (acceptable types, CIDRs, capabilities)
- The negotiated protocol version

A policy denial ends the handshake at this phase.

The TPE operates at **two levels** during federation. The **collective level**
applies to the federation handshake itself. It uses collective DIDs and a
`collective-identity` rule type that we added to ADR-0011. The **user level**
applies to individual traversals after the link exists. The CHALLENGE phase
calls the TPE with the `collective-identity` rule type. The TPE then evaluates
whether the initiating collective can federate.

**COMMIT**: The initiator signs the challenge to confirm that it accepts the
negotiated terms. It also includes an initial route table snapshot.

**ESTABLISHED**: The responder validates the commitment. It returns a session
UUID (used for all later messages), its own route snapshot, and the agreed
keepalive interval. The link changes to `active` in both brokers.

The system installs no routes until phase 4 completes. If a handshake fails at
any phase, the system logs the full message trace for audit.

### 3. Federation types

- **`peer`** — bilateral, equal standing. Both sides export and import routes
  symmetrically. Neither side has policy authority. This is the default type.
- **`parent-child`** — hierarchical. The parent sets floor and ceiling
  policies (ADR-0011) and the child must enforce them. Child routes cascade
  upward.
- **`transit`** — one collective forwards traffic to reach a third collective,
  like BGP transit. The policy of the transit provider must explicitly opt in.
- **`mesh`** — multi-party agreement. We implemented it as bilateral `peer`
  links with a shared mesh identifier and synchronized policy.

### 4. Route exchange

After the session starts, the brokers exchange route updates over the
persistent gRPC stream:

- **Announcements**: prefixes with attributes (origin DID, path vector,
  community tags, preference). A full sync runs at session start. Incremental
  updates follow.
- **Loop prevention**: each route carries a path vector of collective DIDs
  (analogous to BGP AS-PATH). The receiver rejects routes that contain its own
  DID.
- **Policy filtering**: every route passes through the traversal policy engine
  (ADR-0011) at both the export and the import boundary. The system silently
  drops routes that fail.
- **Origin authentication**: each route announcement includes a detached
  signature from the DID key of the originating collective. The receiving
  brokers verify that the announcing collective is the legitimate origin or
  holds a signed transit delegation from the origin. This prevents route
  hijacking inside an otherwise-agreed federation scope.
- **Withdrawal**: the sender uses explicit withdrawal messages when prefixes
  become unreachable or policy revokes them. Withdrawals propagate
  transitively.
- **Convergence**: less than 5 seconds per hop for incremental updates. Less
  than 30 seconds end-to-end for a 3-hop topology change.

### 5. Keepalive and health

Both brokers send `KEEPALIVE` at a negotiated interval (default 60s, range
10-300s). After three consecutive misses, the session becomes `degraded` and
the broker probes at 5s intervals. After five misses or a TCP disconnect, the
session becomes `down`. The broker then withdraws all routes from the failed
peer immediately. The initiating side reconnects with exponential backoff (1s
to a 5m cap). It runs the full handshake again, with DID and policy
re-verification.

### 6. Revocation

- **Graceful**: either side sends `REVOKE` with an optional reason. The peer
  has a 30-second drain period. After that, the broker withdraws the routes
  and tears down the session.
- **Ungraceful**: heartbeat failure reveals it. The broker withdraws routes
  immediately with no drain. The link changes to `down`, then to `revoked`
  after the backoff ends.
- **Permanent vs. temporary**: `REVOKE` includes a `permanent` flag. A
  temporary revocation keeps the link record for re-establishment. A permanent
  revocation deletes the shared state and requires a new handshake.

### 7. Wire format and versioning

- **Transport**: Discovery and handshake use HTTPS + JSON (low-frequency,
  human-debuggable). Route exchange and keepalive use gRPC + Protobuf
  (high-frequency, compact, streaming-native). Broker-to-broker gRPC uses TLS.
  It uses mutual TLS where available and AT Proto key signatures as fallback
  authentication.
- **Signing**: every message carries a detached JWS. The recipient verifies it
  against the DID document of the sender. The recipient rejects unsigned
  messages.
- **Message size limit**: the maximum is 1MB for each message. The sender must
  paginate a route table snapshot that exceeds 1MB across several messages
  with a continuation token.
- **Versioning**: semver. HELLO and CHALLENGE negotiate the highest version
  that both sides support. A breaking change requires a major version bump.
  Brokers must support at least the current version minus one, for graceful
  rollout.

### 8. Security considerations

- **Handshake spam**: the broker rate limits by collective DID (10 HELLO for
  each DID each minute). It does not rate limit by source IP, because that
  fails through DERP relays where many collectives share an IP. Each HELLO is
  signed, so the broker authenticates the DID before it counts the rate limit.
  The broker rate limits duplicate DIDs from the same source regardless of IP.
  An optional hashcash-style proof-of-work on HELLO (adjustable difficulty)
  adds a further layer.
- **DID spoofing**: the broker verifies signatures against DID documents. Short
  TTL caching and a PLC directory cross-reference for `did:plc` reduce the
  risk.
- **Route injection**: the broker rejects at import any route outside the
  agreed CIDR scope of the federation link.
- **NAT traversal**: DERP relays (ADR-0006, ADR-0010) are the fallback. The
  protocol treats relayed and direct connections the same at the message
  layer.

## Consequences

- **Formal specification needed**: this ADR captures the design. An RFC-style
  document with message schemas, state machine diagrams, and error codes is a
  separate deliverable.
- **Reference implementation**: the `federation-broker` service (ADR-0010)
  implements CFP. The handshake state machine, the route exchange engine, and
  the keepalive logic are its core modules.
- **Interoperability testing**: we need a conformance suite before we can trust
  third-party implementations. The suite must cover handshake edge cases, route
  exchange correctness, and failure modes.
- **Rolling upgrades**: version negotiation and support for one earlier version
  let federated collectives upgrade independently. They do not need
  coordinated deployment windows.
- **Operational visibility**: long-lived stateful sessions need first-class
  tooling. The broker admin API and the federation dashboard must show session
  state, route tables, heartbeat status, and handshake history.
- **DoS surface**: we must monitor and harden the internet-facing gRPC
  endpoint. Rate limiting and proof-of-work reduce handshake spam but do not
  remove the attack surface.
