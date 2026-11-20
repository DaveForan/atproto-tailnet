# ADR-0033: Federation data plane on the gateway, and services as AT Proto records

**Status:** Deferred (on the roadmap; tabled 2026-11-20)
**Date:** 2026-11-19
**Priority:** P2
**Depends On:** ADR-0029 (gateway node), ADR-0030 (named tailnet services)
**Supersedes (coordinator mode):** the container relay halves of ADR-0020

## Context

Federation in coordinator mode stops at the control plane. Collectives complete
the CFP handshake and agree which CIDRs to share (ADR-0014, ADR-0016,
ADR-0019). No packet crosses: the coordinator stack has no data plane between
instances. ADR-0020 uses `tailscale/tailscale` containers as relay halves. That
works only in Headscale mode and depends on Tailscale code.

Services (ADR-0030) are records in the database of one instance. Other
instances and other AT Proto applications cannot discover them. The identity
model of the project is AT Proto, where users own their data in their PDS.

## Decision

### 1. Federation traffic through the gateway

- The gateway (ADR-0029) is the relay at a federation boundary. It is a node in
  the local tailnet. It has an encrypted link to the gateway of the peer
  collective. Both gateways are on the same instance, or on two instances.
- The gateway advertises the agreed peer CIDRs into the local tailnet. It
  forwards only traffic inside the agreed CIDRs (`filterImportedPrefixes`).
- The traversal policy (ADR-0011) and the scoping rules (ADR-0015) apply at the
  gateway.
- Revoking a link stops forwarding at once.

### 2. Hierarchy

Child collectives with posture Selective or Open share routes and services with
the parent through the gateway, under the same rules.

### 3. Services as AT Proto records

- A published service is also a record in the PDS of the publisher, with a new
  lexicon (for example `cloud.mesotechnics.service`): name, tailnet DID,
  visibility, description.
- The record is signed by the identity of the publisher. The instance verifies
  it against the registry before it serves the service.
- The board becomes a view of service records in the tailnet. Other
  applications can read public records.
- Private service records contain no information that the tailnet does not
  already show. The publisher can choose to not write a record.

## Consequences

- Federation links carry traffic in coordinator mode.
- No Tailscale code in the data plane.
- Users own the records of their services.

## Open questions

- Lexicon name and schema.
- Whether private services should write records at all.
- Gateway-to-gateway transport between instances: WireGuard between gateways,
  or CFP-authenticated tunnels over HTTPS.

## Status: deferred (2026-11-20)

Federation stays on the roadmap. Work is paused so that single-instance
tailnets can ship first. The instance turns federation off by default:
`FEDERATION_ENABLED=false` in the service and `COORD_FEDERATION_ENABLED` unset
in the coordinator. The dashboard hides the Federation and Traversal tabs.

### What exists

| Area | State |
|---|---|
| Link lifecycle (request, accept, reject, revoke) | Done in the TS service. Same-instance links write the database. Cross-instance links send signed LINK_* messages through an outbox with retry and backoff. |
| Message signing | Done. TS and Rust sign RFC 8785 (JCS) payloads. Shared test vectors prove that both sides produce the same bytes. |
| CFP handshake | Done in the TS service (HELLO, CHALLENGE, COMMIT). Type-bound challenge responses. Sender and signature checks on every message. |
| CIDR agreement and import filter | Done. `filterImportedPrefixes` imports only prefixes inside agreed CIDRs. |
| Route install | Done for both modes: Headscale `autoApprovers`, coordinator auto-approvers for `tag:federation-relay`. |
| Data plane (traffic between collectives) | **Missing.** This ADR (gateway as relay) is not built. ADR-0020 container relays work only in Headscale mode. |
| Rust CFP endpoints and broker | Behind `COORD_FEDERATION_ENABLED`. The outbound handshake builds its first message but does not send it (`coord-federation/src/broker.rs`, `initiate_outbound_handshake`). |
| Tests between two live instances | **Not done.** |

### Code kept on purpose

These modules have no production caller today. They are scaffolding for this
work. Do not delete them as dead code. Wire them in or replace them when work
resumes:

- TS: `src/federation/session.ts`, `src/federation/route-engine.ts`,
  `src/federation/scoping.ts` (one schema in use).
- Rust: `coord-federation/src/session.rs`, `scoping.rs`, `transport.rs`,
  `route_engine.rs` (only `prefix_within_scope` in use).

### Known gaps to close before federation is turned on

- Data plane: build Decision §1 (gateway relay, same instance first, then
  between instances). Settle the open question on gateway-to-gateway transport.
- Multi-replica: the TS handshake state (`pendingHandshakes` in
  `src/routes/federation-messages.ts`) and the replay guards (TS and Rust) are
  per process. Move them to PostgreSQL before more than one replica serves
  federation.
- Rust broker: send the outbound handshake, or remove the Rust CFP path and keep
  the TS service as the only federation endpoint. Choose one.
- Traversal policy (ADR-0011): stored and simulated, never enforced. Enforce it
  at the gateway (Decision §1).
- Wire format: the JCS change is a flag-day change. Instances that run older
  code cannot verify messages from newer instances. Add a protocol version to
  CFP messages before the first two independent instances federate.
- Test plan: two instances, real Tailscale clients on both sides, traffic in
  agreed CIDRs only, revoke stops traffic at once.

### When to resume

Resume when single-instance tailnets run in production, and one of these is
true:

- A second collective needs to reach the services of a first one.
- Services as AT Proto records (Decision §3) are needed for discovery.

