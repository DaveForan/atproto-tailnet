# ADR-0027: Built-in DERP relay and STUN server

**Status:** Proposed
**Date:** 2026-11-19
**Priority:** P0
**Depends On:** ADR-0006 (custom DERP regions), ADR-0023 (Rust mesh coordinator)

## Context

When two devices cannot connect directly, Tailscale clients send WireGuard
packets through a DERP relay. The relay forwards encrypted packets by node key.
It cannot read them.

The coordinator default DERP map has one region: `derp1.tailscale.com`
(`coordinator/crates/coord-api/src/state.rs`). Production does not set
`COORD_DERP_MAP`. Thus all relayed traffic of every tailnet goes through a
server that Tailscale Inc. operates. This has these effects:

- The instance depends on the availability and policy of a third party.
- The third party sees which nodes communicate, when, and how much.
- This conflicts with the goal of a self-contained implementation.

The repository can point tailnets at other relays (ADR-0006: per-tenant regions
900-999, and `COORD_DERP_MAP`). The repository has no relay server of its own.
The Headscale-mode "embedded DERP" toggle uses the relay inside Headscale, which
is not our code. In coordinator mode the toggle is always off.

## Decision

Build a DERP relay server and a STUN server in Rust. They are part of the
coordinator stack. A new crate, `coord-derp`, holds the server. `coord-server`
mounts it.

### DERP protocol

The server implements the DERP wire protocol as Tailscale clients expect it.
The Tailscale open-source Go implementation is the reference specification. It
is not a dependency.

- `GET /derp` with HTTP upgrade (and the WebSocket variant).
- Handshake: the server sends its public key with the fixed magic prefix. The
  client sends a sealed client-info frame (NaCl box). The server sends a sealed
  server-info frame.
- Frames: 1-byte type, 4-byte big-endian length, payload. The server supports
  `SendPacket` → `RecvPacket` forwarding, `KeepAlive`, `Ping`/`Pong`,
  `NotePreferred` and `PeerGone`.
- One task per connection, a map from node key to connection, a bounded send
  queue per connection (drop on overflow, the same as the reference behavior).
- Helper endpoints: `/derp/probe`, `/derp/latency-check`, `/generate_204`.

### STUN

A STUN server on UDP 3478 answers binding requests with `XOR-MAPPED-ADDRESS`.
Clients use it to find their public endpoint. This lets devices find direct
paths, so that less traffic uses the relay.

### Access control

The relay serves only nodes that are registered with this coordinator. At
handshake, the server checks the client node key against the store and closes
unknown connections. The reference `derper` is open to anybody unless the
operator configures client verification.

Per-node rate limits and byte limits prevent abuse.

### Deployment

- Hostname `derp.<APEX_DOMAIN>`. Caddy terminates TLS and proxies the upgrade.
- The cloud firewall opens UDP 3478.
- The default DERP map points at the built-in relay. `derp1.tailscale.com` is
  removed from the default.
- Per-tenant regions (ADR-0006) continue to work. They add regions.
- Crypto comes from primitive crates (`crypto_box` or equivalent), the same as
  the existing use of `snow` and `chacha20poly1305`.

Mesh between several relays (more regions) is out of scope for this ADR.

## Consequences

- No traffic of the instance goes through Tailscale infrastructure.
- The droplet carries relayed traffic. Direct paths (STUN) keep this small.
- The gateway (ADR-0029) uses this relay to reach devices behind NAT.

## Acceptance

- `tailscale netcheck` on a device shows the built-in region.
- Two devices behind NAT exchange traffic through the built-in relay.
- With UDP open, the devices change to a direct path.
- A node key that is not registered cannot use the relay.
- Unit tests cover frame encoding, the handshake and forwarding. An integration
  test uses two real Tailscale clients.
