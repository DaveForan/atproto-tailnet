# ADR-0019: Cross-instance federation links

**Status:** Deferred: the control plane is done; traffic needs ADR-0033 (tabled 2026-11-20)
**Date:** 2026-11-04
**Priority:** P0
**Depends On:** ADR-0014 (federation protocol), ADR-0016 (federation transport), ADR-0017 (DID resolution)

## Context

ADR-0016 made the federation handshake real. Two collectives exchange signed
HELLO and COMMIT messages over HTTP, authenticate each other by DID, and keep a
session alive. But both collectives must be tenants of the **same**
atproto-tailnet instance. The "internet of internets" goal (ADR-0010) needs a
collective on one instance to federate with a collective on another instance.

We investigated the current code. The transport is ready, and the data model
blocks cross-instance federation:

| Area | Today | Blocks cross-instance? |
|------|-------|------------------------|
| `federation_links.requesterTenantId` / `targetTenantId` | Both are NOT NULL foreign keys to the local `tenants` table | **Yes** — a remote collective has no tenant row |
| `broker_sessions.remoteTenantId` | Foreign key to local `tenants` | **Yes** |
| Link request (`POST .../federation`) | Looks the target up by `targetSlug` in the local DB; request and accept are two writes to one shared row | **Yes** — no message carries a request or its acceptance to another instance |
| HELLO policy check | "Is there an active link between the two local tenants that own these DIDs?" | **Yes** — keyed on tenant ids |
| Peer broker URL | `requesterBrokerEndpoint` / `targetBrokerEndpoint` columns exist but nothing ever writes them; the broker falls back to its own `PUBLIC_URL` | Yes |
| `federation_links.signedRequest` | Column exists, never written or read | — (intended for exactly this) |
| Transport, `CFP-Recipient` addressing, signature checks, did:web resolution with SSRF guard | Instance-agnostic | No |
| Discovery document (`/.well-known/collective-federation?collective=slug`) | Served and signed; nothing consumes it | No |
| Link CIDRs | `z.string().min(1)` — any string is accepted, with no check that it is a CIDR or that the collective owns it | Not a blocker, but unsafe once the peer is a stranger |

Two more facts shape the design:

- **People** negotiate a link before any handshake. An operator on each side
  approves the CIDRs to share. Inside one instance, this negotiation is a pair
  of authenticated API calls against one row. Across instances, it must be a
  pair of signed messages between brokers.
- When peers can be strangers on the internet, the inbound endpoints accept
  input from anyone. Today's protections (signature required, active link
  required for HELLO) cover the handshake. They do not cover link *requests*.
  Link requests are unsolicited by nature.

## Decision

### 1. A link row is one collective's view of a peer

We replaced the two-tenant link row with a per-side row. This mirrors what
ADR-0016 already did for `broker_sessions`:

```
federation_links
  id
  local_tenant_id      FK tenants          — the collective this row belongs to
  peer_did             text                — the other collective's DID
  peer_broker_url      text                — where its broker is reached
  peer_name            text                — display name from its descriptor
  direction            outgoing | incoming — who asked
  status               pending | active | rejected | revoked
  local_cidrs          jsonb               — what we share
  peer_cidrs           jsonb               — what the peer shares with us
  message, signed_request, reviewed_by_id, protocol_version, timestamps
  UNIQUE (local_tenant_id, peer_did) WHERE status IN (pending, active)
```

`broker_sessions.remoteTenantId` became `peer_did`. A session references the
link row of its side.

Two collectives on the same instance are no longer a special case. Each has
its own row that names the DID of the other. The brokers talk over HTTP, the
same way as they would across instances (as they already do today). The
migration splits each existing row into its two views.

### 2. Link negotiation becomes signed broker messages

We added three CFP message types. The sender sends them to the broker of the
peer. They use the same `CFP-Recipient` addressing and detached-JWS signature
as the handshake (ADR-0016). Each carries a timestamp and a unique message id:

| Message | Sent when | Effect on the receiver |
|---------|-----------|------------------------|
| `LINK_REQUEST` | An operator requests federation | Creates an `incoming` / `pending` row with the requester's DID, broker URL, offered CIDRs and note |
| `LINK_ACCEPT` | The target's operator accepts | Requester's `outgoing` row becomes `active` and records the peer's CIDRs; the accepting side then initiates HELLO as today |
| `LINK_REJECT` | The target's operator declines | Requester's row becomes `rejected` |

Revocation of an active link keeps the session-level `REVOKE`. A `LINK_REVOKE`
covers links that are still pending or have no session.

The system stores the signed `LINK_REQUEST` in `signed_request`. The approval
of the operator is therefore of a specific, verifiable offer. The audit trail
does not depend on trust in the local row.

The existing API routes keep their shape. `POST .../federation` accepts a
**peer address** instead of a local slug and performs discovery (below). The
accept, reject, and revoke routes update the local row and send the matching
message. The local write happens first. The broker loop retries delivery. An
unreachable peer therefore delays a link but does not lose it.

### 3. Peer discovery

An operator names a peer as `slug@host` (or pastes its DID). The broker does
these steps:

1. Fetches `https://<host>/.well-known/collective-federation?collective=<slug>`
2. Resolves the `collectiveDid` that the descriptor names (ADR-0017) and
   verifies the signature of the descriptor against that key
3. Checks that the `federationPolicy` of the descriptor is not `closed`
4. Records `peer_did`, `brokerUrl` and the name on the link row

The DID is the identity. The descriptor only says where the broker of that
identity lives. The broker trusts the descriptor because the key of the DID
signs it. Brokers resolve the descriptor again when a send fails, so a peer can
move.

Registry-based and PDS-based discovery (ADR-0010 §5, ADR-0015) stay out of
scope. They find peers. This ADR covers links to a peer that you can already
name.

### 4. Who can send what

| Message | Accepted from |
|---------|---------------|
| `LINK_REQUEST` | Any collective whose signature verifies — subject to the recipient's federation posture |
| `LINK_ACCEPT` / `LINK_REJECT` | Only the peer of a matching `outgoing` / `pending` row |
| `HELLO` | Only a peer with an `active` row (unchanged) |
| `COMMIT`, `KEEPALIVE`, `REVOKE` | Unchanged from ADR-0016 |

Each collective gets a **federation posture** setting. The existing
`federationPolicy` field of the discovery document shows it:

- `closed` — the collective refuses inbound link requests
- `selective` (default) — the collective queues inbound requests for an
  operator
- `open` — the same as `selective`. We reserve it for future auto-accept under
  traversal policy (ADR-0011)

Lockdown mode refuses inbound requests and blocks the sending of new requests.

The one endpoint that strangers can use has these abuse controls:
- Rate limits for each sender DID and each source address
- A cap on pending inbound requests for each collective (the oldest requests
  expire)
- A bounded message size
- A record of message ids for the freshness window, so that nobody can replay a
  captured request

### 5. Outbound safety

Documents that the peer controls supply the peer broker URLs. Every outbound
federation request therefore applies the same host policy as did:web
resolution (ADR-0017): HTTPS, default port, public addresses only, no
redirects. The `PUBLIC_URL` of the instance itself is exempt. This keeps
same-instance links and local development working.

To test two instances on one machine, a development-only setting lists
additional loopback broker origins to trust. The instance rejects this setting
at startup unless the instance itself is a loopback deployment.

### 6. Validate the CIDRs being agreed

The service parses the shared CIDRs and normalises them as IPv4/IPv6 prefixes.
Then these rules apply:

- A collective can offer only prefixes inside its own tailnet range
  (`tenants.ipv4Prefix` / `ipv6Prefix`) or subnet routes that it has approved.
- The prefixes that a peer offers must not overlap the own range of the local
  collective, the prefixes of any other active link, or default routes.

The service rejects offers that fail at request or accept time, before it asks
an operator to approve them. Import filtering at handshake time
(`filterImportedPrefixes`) stays as the second line of defence.

## Consequences

- A collective can federate with any collective that it can name, on any
  instance, with the same operator workflow as today.
- One code path: same-instance federation stops being a separate case in the
  data model, the policy check, and the dashboard.
- `federation_links` and `broker_sessions` change shape. The migration rewrites
  the existing rows. It also rewrites every query that joins them to `tenants`
  for the name of the peer.
- The internet gets a new surface that session authentication does not cover
  (`LINK_REQUEST`). It is the only message that a stranger can cause the system
  to store. Posture, rate limits, and the pending cap bound it.
- Trust in a remote collective rests on did:web. Whoever controls the domain of
  the peer controls its identity. Operators approve a DID, and the dashboard
  must show the host prominently.
- CIDR validation rejects links that the system accepts today. In particular,
  every tenant defaults to `100.64.0.0/10`. Two tenants with default ranges
  cannot share their tailnet ranges until one tenant is renumbered (ADR-0006).
  ADR-0020 explains why the data plane needs this anyway.
- A peer key rotation takes effect within the resolver cache TTL (5 minutes).
  Handshakes and keepalives can fail in that window. They recover on retry.

## Not in scope

- Carrying traffic between the federated tailnets (ADR-0020).
- Registry, PDS-record and mDNS discovery (ADR-0010 §5, ADR-0015).
- Incremental `ROUTE_UPDATE` exchange after establishment, and the transit and
  mesh federation types (ADR-0014 §3–4).
