# ADR-0033: Federation data plane on the gateway, and services as AT Proto records

**Status:** Proposed
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
