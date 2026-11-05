# ADR-0016: Federation transport and broker integration

**Status:** Implemented
**Date:** 2026-11-04
**Priority:** P0
**Depends On:** ADR-0014 (federation protocol specification), ADR-0010 (federation control plane)

## Context

ADR-0014 specifies the Collective Federation Protocol (CFP) — a 4-phase
handshake, route exchange, keepalive, and revocation model. ADR-0010 defines
the federation broker as the runtime component that manages federation
sessions. Both are implemented as pure state machines and tested in isolation,
but **no integration layer connects them to the running application**.

Specifically:
- `startBroker()` is defined but never called at app startup
- Accepting a federation link in the DB does not trigger a handshake
- No HTTP transport exists for inter-instance handshake messages
- The route engine is not connected to Headscale ACL installation
- No keepalive background loop runs

Without this integration, federation is designware — the protocol exists but
two instances cannot actually federate.

## Decision

### 1. Broker lifecycle

Call `startBroker()` from `src/index.ts` at app startup, after the health
monitor. The broker runs a reconciliation loop (30s default) that:
- Scans `federation_links` for active links and ensures each has its sessions
- Initiates (and retries) outbound handshakes for sessions still `connecting`
- Sends keepalives and checks keepalive health for established sessions
- Tears down sessions whose link is no longer active
- Handles graceful shutdown via `stopBroker()`

Each active link has **two** `broker_sessions` rows — one per side, each
holding that tenant's view of its peer (`localTenantId`, its exported and
imported routes). The side that accepted the link initiates the handshake.

### 2. HTTP transport for handshake messages

Expose federation message endpoints on each instance:

```
POST /api/federation/messages/hello      → responds with CHALLENGE
POST /api/federation/messages/commit     → responds with ESTABLISHED
POST /api/federation/messages/keepalive
POST /api/federation/messages/revoke
```

The handshake is two request/response exchanges driven by the initiator, so
CHALLENGE and ESTABLISHED travel as HTTP responses rather than as separate
inbound endpoints.

Each endpoint:
- Accepts a signed CFP message as JSON body (Zod-validated)
- Identifies the addressed collective from the `CFP-Recipient` header (its
  DID) — one instance hosts many collectives behind one broker URL
- Verifies the sender's DID signature over the message as transmitted, and
  that its timestamp is within 5 minutes of now
- Dispatches to the appropriate handshake state machine function
- Returns the response message (or error)

Authentication is by DID signature verification, not session cookies —
these are machine-to-machine endpoints between federation brokers. They are
mounted ahead of the session/agent-token API stack with their own rate limit.

Signatures are detached JWS (`{"alg":"EdDSA"}` header) over the message minus
its `signature` field, produced and checked by `src/identity/keys.ts` and
`src/federation/auth.ts`. Rules enforced on top of the ADR-0014 state machine:

- **HELLO** is only accepted from a collective that has an *active federation
  link* with the recipient. A valid signature alone is not enough.
- **COMMIT** must come from the same DID that sent the HELLO for that nonce;
  nonces are single-use and expire with the challenge.
- The initiator verifies the peer's signature on **CHALLENGE** and
  **ESTABLISHED** against the DID it expects from the link.
- **KEEPALIVE** and **REVOKE** carry a signature and must be signed by the
  session's peer; the session is looked up by the CFP session id agreed in the
  handshake (`broker_sessions.cfp_session_id`), scoped to the recipient.

### 3. Link acceptance triggers handshake

When a federation link is accepted (`POST .../federation/:linkId/accept`),
the route handler notifies the broker to initiate the outbound handshake
to the remote broker's federation message endpoint. The broker URL is the
peer's endpoint recorded on the link (`requesterBrokerEndpoint` /
`targetBrokerEndpoint`), defaulting to this instance's own `PUBLIC_URL` —
today both collectives of a link are tenants of the same instance, and the
handshake runs over HTTP against ourselves. If the immediate attempt fails,
the reconciliation loop retries it.

### 4. Route installation via Headscale

When a handshake reaches ESTABLISHED and routes are exchanged:
- Each side imports only the peer's announced prefixes that match the CIDRs
  agreed on the link and that the peer itself originates — a peer cannot
  announce a wider prefix or someone else's network
- The broker calls `HeadscaleApiClient.getPolicy()` to read the current ACL
- Merges the imported CIDRs into the ACL's `autoApprovers.routes`, approved
  for `tag:federation-relay` only (declared in `tagOwners` if missing), so an
  ordinary member device advertising a federated CIDR is not auto-approved
- Calls `HeadscaleApiClient.setPolicy()` to install the updated ACL
- On session teardown or revocation, removes the entries it added (unless
  another session of the tenant still imports the CIDR)

### 5. Keepalive loop

The broker's reconciliation loop handles keepalives:
- For each established or degraded session, send a signed keepalive via HTTP POST
- A keepalive received from, or acknowledged by, the peer refreshes
  `lastKeepalive`; sessions with none for 90s are marked `degraded` and
  recover on the next successful exchange

### 6. Signed discovery document

The `.well-known/collective-federation` endpoint signs its response
with the collective's Ed25519 key (stored in `collective_dids`),
producing a detached JWS signature in the `signature` field.

## Consequences

- Two atproto-tailnet instances can complete a full federation lifecycle:
  discover → request → accept → handshake → route exchange → keepalive → revoke
- Federation messages travel over HTTPS between instances, authenticated by
  DID signatures — no additional auth infrastructure required
- Headscale ACLs are the enforcement point for federated routes
- The broker must handle partial failures gracefully (remote unreachable,
  handshake timeout, signature verification failure)
- Instance URL must be reachable by federation partners (public endpoint or
  relay); NAT traversal is out of scope for this ADR

## Known limitations

- **Same-instance only.** `federation_links` references both parties as local
  tenants, so a collective hosted on another instance cannot be linked yet.
  The transport, addressing and DID resolution are instance-agnostic; the
  data model (remote collective as DID + broker URL) is the missing piece.
- **No data plane.** Relay node provisioning is still a stub (ADR-0010), so
  installed auto-approvers have no relay advertising routes behind them. The
  `tag:federation-relay` policy edit has unit tests but has not been exercised
  against a live Headscale instance.
- Pending handshake state (between HELLO and COMMIT) is held in memory; a
  restart mid-handshake is recovered by the retry loop.
