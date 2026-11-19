# ADR-0024: Purpose-built mesh client

**Status:** Proposed
**Date:** 2026-11-06
**Priority:** P2
**Depends On:** ADR-0023 (Rust mesh coordinator)

## Context

ADR-0023 builds a Rust coordinator that maintains Tailscale client wire
compatibility during Phases 1-3. This compatibility constraint has these
effects:

- The coordinator must speak `Noise_IK_25519_ChaChaPoly_BLAKE2s` with the
  prologue `"Tailscale Control Protocol v<N>"`
- It must serve `/key` and `/ts2021`. It must also handle HTTP/2-over-Noise for
  `/machine/register` and `/machine/map`
- MapResponse must be JSON with the exact field set that Tailscale clients
  expect
- DERP relay connections use NaCl box auth (different from the control Noise)
- The coordinator cannot add custom control messages (credential presentation,
  namespace-aware routing) without breaking the `tailscale` CLI

The Tailscale client is a complex Go codebase of more than 400k lines. It
handles the WireGuard tunnel, the Noise handshake, the DERP relay, NAT
traversal (ICE-like with proprietary extensions), MagicDNS, exit nodes, subnet
routes, Taildrop, SSH, and more. Most of this is irrelevant to our use case.
Some of it actively conflicts with the hierarchical federated model:
account-based auth, the single-coordinator assumption, and the flat namespace.

When the Rust coordinator reaches Phase 4 (protocol divergence), we need a
purpose-built client for these reasons:

1. **Carry credential presentations in-band.** The control protocol needs a way
   to present AT Proto service-auth tokens and VCs during the handshake or as
   part of map requests. The control messages of Tailscale have no extension
   points for this.

2. **Support namespace-aware routing.** The client must understand hierarchical
   CIDR scopes. Traffic to a sub-collective routes through a different
   WireGuard peer than traffic to the parent.

3. **Participate in federation handshakes.** Relay nodes at federation
   boundaries need client-side logic for the CFP protocol: challenge signing,
   route advertisement filtering, and credential relay.

4. **Remove unnecessary complexity.** The client has no Taildrop, no SSH, no
   MagicDNS (we use our own DNS), no Tailscale account system, and no
   funnel/serve. The client must do WireGuard, coordination, DERP relay, and
   NAT traversal, and nothing else.

## Decision

We will build a purpose-built mesh client in Rust after the coordinator reaches
Phase 3 (federation native). The client replaces the `tailscale` daemon for
nodes in atproto-tailnet networks.

### Phased approach

**Phase A: Coordinator compatibility (ADR-0023 Phases 1-3)**
Continue to use the stock Tailscale client. No client work is necessary.

**Phase B: Protocol bridge client**
A Rust client that speaks the extended coordinator protocol (custom control
messages for credentials and namespaces). It delegates WireGuard tunneling to
the existing implementation of the system (kernel WireGuard or `boringtun`).

- Custom Noise handshake with a credential presentation extension
- Extended MapResponse handling (namespace metadata, credential requirements)
- DERP relay client that uses NaCl box auth (compatible with existing relays)
- Configurable through TOML/YAML, no GUI

**Phase C: Full mesh client**
- Integrated WireGuard through `boringtun` (no kernel module dependency)
- NAT traversal (ICE-like, using STUN + DERP relay as fallback)
- MagicDNS replacement (namespace-aware DNS resolution)
- Federation relay participation (CFP client-side protocol)
- Optional: GUI through `egui` or system tray integration

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

The extended control protocol diverges from the Tailscale protocol in these
ways:

1. **Noise prologue** changes from `"Tailscale Control Protocol v<N>"` to
   `"ATProto Mesh Protocol v<N>"`. Clients and coordinator negotiate which
   protocol to use based on the `/key` response

2. **Registration includes DID** — the `/machine/register` payload carries the
   `did:plc` or `did:web` identifier of the account. It also carries an
   optional service-auth JWT for immediate holder binding

3. **MapResponse extensions** — additional fields for namespace hierarchy,
   credential requirements for each peer, and federation boundary markers

4. **Credential control message** — a new message type for in-band credential
   presentation and challenge-response during active sessions

## Consequences

- **Tailscale client remains supported in Phase B.** The coordinator can detect
  which protocol the client speaks. It then serves the correct response format.
  Mixed deployments work.
- **No lock-in to the release cycle of Tailscale.** Client updates ship with
  the project. They do not wait for Tailscale releases.
- **NAT traversal is the hardest part.** The proprietary NAT traversal
  extensions of Tailscale took years to mature. Phase B avoids this problem. It
  relies on DERP for relay and adds direct connections incrementally.
- **This is a Phase 4+ concern.** No implementation work starts until the
  coordinator is functional and federated. This ADR documents the destination
  and prevents short-term decisions that foreclose it.

## Risks

- **NAT traversal maturity.** The NAT traversal of Tailscale works across
  extremely hostile networks (symmetric NAT, CGNAT, corporate firewalls). A new
  implementation will take time to reach that level. DERP relay provides full
  connectivity as a fallback.
- **Client distribution.** A custom client means that users install our
  software instead of `tailscale`. The trust and distribution story needs
  design work (signed binaries, package repos, auto-update).
- **Platform coverage.** Tailscale supports Linux, macOS, Windows, iOS, and
  Android. A Rust client can target all of them through cross-compilation. But
  platform integration (system tray, network extensions, VPN APIs) is
  per-platform work.
