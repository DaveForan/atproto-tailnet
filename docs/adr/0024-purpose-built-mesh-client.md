# ADR-0024: Purpose-built mesh client

**Status:** Proposed
**Date:** 2026-11-06
**Priority:** P2
**Depends On:** ADR-0023 (Rust mesh coordinator)

## Context

ADR-0023 builds a Rust coordinator that maintains Tailscale client wire
compatibility during Phases 1-3. This compatibility constraint means:

- The coordinator must speak `Noise_IK_25519_ChaChaPoly_BLAKE2s` with the
  prologue `"Tailscale Control Protocol v<N>"`
- It must serve `/key`, `/ts2021`, and handle HTTP/2-over-Noise for
  `/machine/register` and `/machine/map`
- MapResponse must be JSON with the exact field set Tailscale clients expect
- DERP relay connections use NaCl box auth (different from the control Noise)
- The coordinator cannot add custom control messages (credential
  presentation, namespace-aware routing) without breaking `tailscale` CLI

The Tailscale client is a complex 400k+ line Go codebase handling:
WireGuard tunnel, Noise handshake, DERP relay, NAT traversal (ICE-like
with proprietary extensions), MagicDNS, exit nodes, subnet routes,
Taildrop, SSH, and more. Most of this is irrelevant to our use case and
some of it (account-based auth, single-coordinator assumption, flat
namespace) actively conflicts with the hierarchical federated model.

Once the Rust coordinator reaches Phase 4 (protocol divergence), a
purpose-built client becomes necessary to:

1. **Carry credential presentations in-band.** The control protocol needs
   a way to present AT Proto service-auth tokens and VCs during the
   handshake or as part of map requests. Tailscale's control messages have
   no extension points for this.

2. **Support namespace-aware routing.** The client needs to understand
   hierarchical CIDR scopes — that traffic to a sub-collective routes
   through a different WireGuard peer than traffic to the parent.

3. **Participate in federation handshakes.** Relay nodes at federation
   boundaries need client-side logic for the CFP protocol: challenge
   signing, route advertisement filtering, and credential relay.

4. **Remove unnecessary complexity.** No Taildrop, no SSH, no MagicDNS
   (we use our own DNS), no Tailscale account system, no funnel/serve.
   The client should do WireGuard + coordination + DERP relay + NAT
   traversal, nothing else.

## Decision

Build a purpose-built mesh client in Rust after the coordinator reaches
Phase 3 (federation native). The client replaces the `tailscale` daemon
for nodes in atproto-tailnet networks.

### Phased approach

**Phase A: Coordinator compatibility (ADR-0023 Phases 1-3)**
Continue using the stock Tailscale client. No client work needed.

**Phase B: Protocol bridge client**
A Rust client that speaks the extended coordinator protocol (custom control
messages for credentials, namespaces) but delegates WireGuard tunneling to
the system's existing implementation (kernel WireGuard or `boringtun`).

- Custom Noise handshake with credential presentation extension
- Extended MapResponse handling (namespace metadata, credential requirements)
- DERP relay client using NaCl box auth (compatible with existing relays)
- Configurable via TOML/YAML, no GUI

**Phase C: Full mesh client**
- Integrated WireGuard via `boringtun` (no kernel module dependency)
- NAT traversal (ICE-like, using STUN + DERP relay as fallback)
- MagicDNS replacement (namespace-aware DNS resolution)
- Federation relay participation (CFP client-side protocol)
- Optional: GUI via `egui` or system tray integration

### Architecture

```
mesh-client/
  crates/
    client-core/     — Config, state machine, key management
    client-noise/    — Noise IK with credential extensions
    client-wg/       — WireGuard tunnel (boringtun wrapper)
    client-derp/     — DERP relay client
    client-nat/      — NAT traversal (STUN + ICE-like)
    client-dns/      — Namespace-aware DNS resolver
    client-cli/      — CLI binary
```

### Protocol extensions

The extended control protocol diverges from Tailscale's in these ways:

1. **Noise prologue** changes from `"Tailscale Control Protocol v<N>"` to
   `"ATProto Mesh Protocol v<N>"` — clients and coordinator negotiate
   which protocol to use based on the `/key` response

2. **Registration includes DID** — the `/machine/register` payload carries
   the account's `did:plc` or `did:web` identifier and an optional
   service-auth JWT for immediate holder binding

3. **MapResponse extensions** — additional fields for namespace hierarchy,
   credential requirements per peer, federation boundary markers

4. **Credential control message** — new message type for in-band
   credential presentation and challenge-response during active sessions

## Consequences

- **Tailscale client remains supported in Phase B.** The coordinator can
  detect which protocol the client speaks and serve the appropriate
  response format. Mixed deployments work.
- **No lock-in to Tailscale's release cycle.** Client updates ship with
  the project, not when Tailscale releases.
- **NAT traversal is the hardest part.** Tailscale's proprietary NAT
  traversal extensions took years to mature. Phase B sidesteps this by
  relying on DERP for relay, adding direct connections incrementally.
- **This is a Phase 4+ concern.** No implementation work until the
  coordinator is functional and federated. This ADR exists to document
  the destination and prevent short-term decisions that foreclose it.

## Risks

- **NAT traversal maturity.** Tailscale's NAT traversal works across
  extremely hostile networks (symmetric NAT, CGNAT, corporate firewalls).
  A new implementation will take time to reach that level. DERP relay
  provides full connectivity as a fallback.
- **Client distribution.** A custom client means users install our
  software instead of `tailscale`. The trust and distribution story needs
  design work (signed binaries, package repos, auto-update).
- **Platform coverage.** Tailscale supports Linux, macOS, Windows, iOS,
  Android. A Rust client can target all via cross-compilation but platform
  integration (system tray, network extensions, VPN APIs) is per-platform
  work.
