# ADR-0019: Cross-instance federation links

**Status:** Proposed
**Date:** 2026-11-04
**Priority:** P0
**Depends On:** ADR-0014 (federation protocol), ADR-0016 (federation transport), ADR-0017 (DID resolution)

## Context

ADR-0016 made the federation handshake real: two collectives exchange
signed HELLO / COMMIT messages over HTTP, authenticate each other by DID,
and keep a session alive. But both collectives must be tenants of the
**same** atproto-tailnet instance. The "internet of internets" goal
(ADR-0010) needs a collective on one instance to federate with a collective
on another.

An investigation of the current code shows the transport is ready and the
data model is what blocks it:

| Area | Today | Blocks cross-instance? |
|------|-------|------------------------|
| `federation_links.requesterTenantId` / `targetTenantId` | Both are NOT NULL foreign keys to the local `tenants` table | **Yes** — a remote collective has no tenant row |
| `broker_sessions.remoteTenantId` | Foreign key to local `tenants` | **Yes** |
| Link request (`POST .../federation`) | Looks the target up by `targetSlug` in the local DB; request and accept are two writes to one shared row | **Yes** — there is no message that carries a request or its acceptance to another instance |
| HELLO policy check | "Is there an active link between the two local tenants that own these DIDs?" | **Yes** — keyed on tenant ids |
| Peer broker URL | `requesterBrokerEndpoint` / `targetBrokerEndpoint` columns exist but nothing ever writes them; the broker falls back to its own `PUBLIC_URL` | Yes |
| `federation_links.signedRequest` | Column exists, never written or read | — (intended for exactly this) |
| Transport, `CFP-Recipient` addressing, signature checks, did:web resolution with SSRF guard | Instance-agnostic | No |
| Discovery document (`/.well-known/collective-federation?collective=slug`) | Served and signed; nothing consumes it | No |
| Link CIDRs | `z.string().min(1)` — any string is accepted, with no check that it is a CIDR or that the collective owns it | Not a blocker, but unsafe once the peer is a stranger |

Two further facts shape the design:

- A link is negotiated by **people** (an operator on each side approves the
  CIDRs to share) before any handshake. Within one instance that
  negotiation is a pair of authenticated API calls against one row. Across
  instances it has to be a pair of signed messages between brokers.
- Once peers can be strangers on the internet, the inbound endpoints accept
  input from anyone. Today's protections (signature required, active link
  required for HELLO) cover the handshake but not link *requests*, which
  are by nature unsolicited.

## Decision

### 1. A link row is one collective's view of a peer

Replace the two-tenant link row with a per-side row, mirroring what
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

`broker_sessions.remoteTenantId` becomes `peer_did`; a session references
its side's link row.

Two collectives on the same instance are no longer a special case: each has
its own row naming the other's DID, and the brokers talk over HTTP exactly
as they would across instances (as they already do today). The migration
splits each existing row into its two views.

### 2. Link negotiation becomes signed broker messages

Three new CFP message types, sent to the peer's broker with the same
`CFP-Recipient` addressing and detached-JWS signature as the handshake
(ADR-0016), each carrying a timestamp and a unique message id:

| Message | Sent when | Effect on the receiver |
|---------|-----------|------------------------|
| `LINK_REQUEST` | An operator requests federation | Creates an `incoming` / `pending` row with the requester's DID, broker URL, offered CIDRs and note |
| `LINK_ACCEPT` | The target's operator accepts | Requester's `outgoing` row becomes `active` and records the peer's CIDRs; the accepting side then initiates HELLO as today |
| `LINK_REJECT` | The target's operator declines | Requester's row becomes `rejected` |

Revocation of an active link keeps using the session-level `REVOKE`; a
`LINK_REVOKE` covers links that are still pending or have no session.

The signed `LINK_REQUEST` is stored in `signed_request`, so the operator's
approval is of a specific, verifiable offer, and the audit trail does not
depend on trusting the local row.

The existing API routes keep their shape. `POST .../federation` accepts a
**peer address** instead of a local slug and performs discovery (below);
accept / reject / revoke update the local row and send the corresponding
message. The local write happens first; delivery is retried by the broker
loop, so an unreachable peer delays a link but does not lose it.

### 3. Peer discovery

An operator names a peer as `slug@host` (or pastes its DID). The broker:

1. Fetches `https://<host>/.well-known/collective-federation?collective=<slug>`
2. Resolves the `collectiveDid` it names (ADR-0017) and verifies the
   descriptor's signature against that key
3. Checks the descriptor's `federationPolicy` is not `closed`
4. Records `peer_did`, `brokerUrl` and name on the link row

The DID is the identity; the descriptor only says where that identity's
broker lives, and is trusted because it is signed by the DID's key. Brokers
re-resolve it when a send fails, so a peer can move.

Registry- and PDS-based discovery (ADR-0010 §5, ADR-0015) stay out of
scope: they find peers, whereas this ADR is about linking to one you can
already name.

### 4. Who may send what

| Message | Accepted from |
|---------|---------------|
| `LINK_REQUEST` | Any collective whose signature verifies — subject to the recipient's federation posture |
| `LINK_ACCEPT` / `LINK_REJECT` | Only the peer of a matching `outgoing` / `pending` row |
| `HELLO` | Only a peer with an `active` row (unchanged) |
| `COMMIT`, `KEEPALIVE`, `REVOKE` | Unchanged from ADR-0016 |

Each collective gets a **federation posture** setting, surfaced in the
discovery document's existing `federationPolicy` field:

- `closed` — inbound link requests are refused
- `selective` (default) — inbound requests are queued for an operator
- `open` — as `selective`; reserved for future auto-accept under traversal
  policy (ADR-0011)

Lockdown mode refuses inbound requests and blocks sending new ones.

Abuse controls for the one endpoint strangers can use: rate limits per
sender DID and per source address, a cap on pending inbound requests per
collective (oldest expire), bounded message size, and message ids
remembered for the freshness window so a captured request cannot be
replayed.

### 5. Outbound safety

Peer broker URLs come from documents controlled by the peer, so every
outbound federation request applies the same host policy as did:web
resolution (ADR-0017): HTTPS, default port, public addresses only, no
redirects. The instance's own `PUBLIC_URL` is exempt, which keeps
same-instance links and local development working.

For testing two instances on one machine, a development-only setting lists
additional loopback broker origins to trust. It is rejected at startup
unless the instance itself is a loopback deployment.

### 6. Validate the CIDRs being agreed

Shared CIDRs are parsed and normalised as IPv4/IPv6 prefixes, and:

- a collective may only offer prefixes inside its own tailnet range
  (`tenants.ipv4Prefix` / `ipv6Prefix`) or subnet routes it has approved;
- a peer's offered prefixes must not overlap the local collective's own
  range, any other active link's prefixes, or default routes.

Offers that fail are rejected at request / accept time, before an operator
is asked to approve them. Import filtering at handshake time
(`filterImportedPrefixes`) stays as the second line of defence.

## Consequences

- A collective can federate with any collective it can name, on any
  instance, with the same operator workflow as today.
- One code path: same-instance federation stops being a separate case in
  the data model, the policy check and the dashboard.
- `federation_links` and `broker_sessions` change shape; the migration
  rewrites existing rows and every query that joins them to `tenants` for
  the peer's name.
- A new unauthenticated-by-session surface (`LINK_REQUEST`) is exposed to
  the internet. It is the only message a stranger can cause to be stored,
  and it is bounded by posture, rate limits and the pending cap.
- Trust in a remote collective rests on did:web: whoever controls the
  peer's domain controls its identity. Operators approve a DID, and the
  dashboard must show the host prominently.
- CIDR validation will reject links that are accepted today — in
  particular, every tenant defaults to `100.64.0.0/10`, so two tenants with
  default ranges cannot share their tailnet ranges until one is renumbered
  (ADR-0006). ADR-0020 covers why the data plane needs this anyway.
- Key rotation on a peer is picked up within the resolver's cache TTL
  (5 minutes); handshakes and keepalives may fail in that window and
  recover on retry.

## Not in scope

- Carrying traffic between the federated tailnets (ADR-0020).
- Registry, PDS-record and mDNS discovery (ADR-0010 §5, ADR-0015).
- Incremental `ROUTE_UPDATE` exchange after establishment and transit /
  mesh federation types (ADR-0014 §3–4).
