# ADR-0016: Federation transport and broker integration

**Status:** Implemented
**Date:** 2026-11-04
**Priority:** P0
**Depends On:** ADR-0014 (federation protocol specification), ADR-0010 (federation control plane)

## Context

ADR-0014 specifies the Collective Federation Protocol (CFP). CFP has a 4-phase
handshake, route exchange, keepalive, and a revocation model. ADR-0010 defines
the federation broker as the runtime component that manages federation
sessions. We implemented both as pure state machines and tested them in
isolation. But **no integration layer connects them to the running
application**.

Specifically:
- `startBroker()` exists but the app never calls it at startup
- Acceptance of a federation link in the DB does not start a handshake
- No HTTP transport exists for inter-instance handshake messages
- The route engine does not connect to Headscale ACL installation
- No keepalive background loop runs

Without this integration, federation is designware. The protocol exists, but
two instances cannot federate.

## Decision

### 1. Broker lifecycle

We call `startBroker()` from `src/index.ts` at app startup, after the health
monitor. The broker runs a reconciliation loop (30s default). The loop does
these tasks:
- Scans `federation_links` for active links and ensures that each has its
  sessions
- Starts (and retries) outbound handshakes for sessions that are still
  `connecting`
- Sends keepalives and checks keepalive health for established sessions
- Tears down sessions whose link is no longer active
- Handles graceful shutdown through `stopBroker()`

Each active link has **two** `broker_sessions` rows, one for each side. Each
row holds the view of that tenant of its peer (`localTenantId`, its exported
and imported routes). The side that accepted the link starts the handshake.

### 2. HTTP transport for handshake messages

We expose federation message endpoints on each instance:

```
POST /api/federation/messages/hello      → responds with CHALLENGE
POST /api/federation/messages/commit     → responds with ESTABLISHED
POST /api/federation/messages/keepalive
POST /api/federation/messages/revoke
```

The initiator drives the handshake as two request/response exchanges. CHALLENGE
and ESTABLISHED travel as HTTP responses. They do not use separate inbound
endpoints.

Each endpoint does these steps:
- Accepts a signed CFP message as a JSON body (Zod-validated)
- Identifies the addressed collective from the `CFP-Recipient` header (its
  DID). One instance hosts many collectives behind one broker URL
- Verifies the DID signature of the sender over the message as transmitted, and
  verifies that its timestamp is within 5 minutes of now
- Dispatches to the correct handshake state machine function
- Returns the response message (or an error)

Authentication uses DID signature verification, not session cookies. These are
machine-to-machine endpoints between federation brokers. The app mounts them
ahead of the session/agent-token API stack, with their own rate limit.

The signatures are detached JWS (`{"alg":"EdDSA"}` header) over the message
without its `signature` field. `src/identity/keys.ts` and
`src/federation/auth.ts` produce and check them. The code enforces these rules
on top of the ADR-0014 state machine:

- **HELLO**: the broker accepts it only from a collective that has an *active
  federation link* with the recipient. A valid signature alone is not enough.
- **COMMIT**: it must come from the same DID that sent the HELLO for that
  nonce. Nonces are single-use and expire with the challenge.
- The initiator verifies the signature of the peer on **CHALLENGE** and
  **ESTABLISHED** against the DID that it expects from the link.
- **KEEPALIVE** and **REVOKE**: they carry a signature and the peer of the
  session must sign them. The broker finds the session by the CFP session id
  that both sides agreed in the handshake (`broker_sessions.cfp_session_id`),
  scoped to the recipient.

### 3. Link acceptance triggers handshake

When a user accepts a federation link (`POST .../federation/:linkId/accept`),
the route handler tells the broker to start the outbound handshake to the
federation message endpoint of the remote broker. The broker URL is the
endpoint of the peer that the link records (`requesterBrokerEndpoint` /
`targetBrokerEndpoint`). It defaults to the `PUBLIC_URL` of this instance.
Today both collectives of a link are tenants of the same instance, and the
handshake runs over HTTP against ourselves. If the immediate attempt fails, the
reconciliation loop retries it.

### 4. Route installation via Headscale

When a handshake reaches ESTABLISHED and the brokers exchange routes, the
broker does these steps:
- Each side imports only the announced prefixes of the peer that match the
  CIDRs agreed on the link and that the peer itself originates. A peer cannot
  announce a wider prefix or the network of someone else
- The broker calls `HeadscaleApiClient.getPolicy()` to read the current ACL
- The broker merges the imported CIDRs into `autoApprovers.routes` of the ACL.
  It approves them for `tag:federation-relay` only (declared in `tagOwners` if
  missing). An ordinary member device that advertises a federated CIDR is
  therefore not auto-approved
- The broker calls `HeadscaleApiClient.setPolicy()` to install the updated ACL
- On session teardown or revocation, the broker removes the entries that it
  added (unless another session of the tenant still imports the CIDR)

### 5. Keepalive loop

The reconciliation loop of the broker handles keepalives:
- For each established or degraded session, send a signed keepalive with HTTP
  POST
- A keepalive that the broker receives from the peer, or that the peer
  acknowledges, refreshes `lastKeepalive`. A session with no keepalive for 90s
  becomes `degraded`. It recovers on the next successful exchange

### 6. Signed discovery document

The `.well-known/collective-federation` endpoint signs its response with the
Ed25519 key of the collective (stored in `collective_dids`). The signature is a
detached JWS in the `signature` field.

## Consequences

- Two atproto-tailnet instances can complete a full federation lifecycle:
  discover → request → accept → handshake → route exchange → keepalive → revoke
- Federation messages travel over HTTPS between instances. DID signatures
  authenticate them. No additional auth infrastructure is necessary
- Headscale ACLs are the enforcement point for federated routes
- The broker must handle partial failures gracefully (remote unreachable,
  handshake timeout, signature verification failure)
- The instance URL must be reachable by federation partners (public endpoint or
  relay). NAT traversal is out of scope for this ADR

## Known limitations

- **Same-instance only.** `federation_links` references both parties as local
  tenants, so we cannot yet link a collective that another instance hosts. The
  transport, the addressing, and the DID resolution do not depend on the
  instance. The data model (remote collective as DID and broker URL) is the
  missing piece.
- **No data plane.** Relay node provisioning is still a stub (ADR-0010). The
  installed auto-approvers therefore have no relay that advertises routes
  behind them. The `tag:federation-relay` policy edit has unit tests, but we
  have not run it against a live Headscale instance.
- The broker holds pending handshake state (between HELLO and COMMIT) in
  memory. The retry loop recovers a restart in the middle of a handshake.
