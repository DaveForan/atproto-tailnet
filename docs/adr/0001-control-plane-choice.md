# ADR-0001: Use Headscale as the Tailscale control plane

**Status:** Accepted
**Date:** 2026-10-23

## Context

We are building a service ("atproto-tailnet") where users authenticate via their AT Protocol identity (Bluesky handle / DID) and receive isolated Tailscale-compatible mesh networks (tailnets). We need an open-source Tailscale control server implementation.

### Options considered

| Option | Pros | Cons |
|--------|------|------|
| **Headscale** | Only mature OSS Tailscale control server (38.5k stars, v0.29.1). Full Tailscale client compatibility. Active development. Well-structured Go codebase (~40K core LOC). | Single-tenant by design. Maintainers explicitly reject multi-tenancy (issues #2711, #1370, #2738). |
| **Netmaker** | Native multi-tenancy (v1.7 Organizations/Tenants). WireGuard-based. | Requires its own client (`netclient`), incompatible with stock Tailscale clients. |
| **NetBird** | MSP-style multi-tenant management. WireGuard-based. | Own client required. Enterprise multi-tenant features may require commercial license. |
| **Build from scratch** | Could design multi-tenancy natively. | Tailscale control protocol is undocumented. Would require implementing Noise IK handshakes, netmap distribution, DERP coordination. Enormous effort. |
| **ZeroTier / Nebula** | Mature mesh networking. ZeroTier supports multiple networks per node. | Different protocols entirely, not Tailscale-compatible. |

### Why Tailscale compatibility matters

Tailscale has the largest install base of any mesh VPN. Users already have the client on their machines. The `tailscale up --login-server` flag lets any Tailscale client point at a custom control server with zero client modifications. This network effect is our distribution advantage.

## Decision

Use **Headscale** as the control plane. It is the only open-source implementation that speaks the Tailscale control protocol, meaning stock Tailscale clients work unmodified. No other project combines Tailscale client compatibility with open-source availability.

## Consequences

- We inherit Headscale's single-tenant limitation (see ADR-0002 for how we handle this).
- We track Headscale releases for security patches and protocol compatibility.
- We benefit from Headscale's existing OIDC support, ACL engine, and DERP relay handling.
- Users connect with stock Tailscale clients (`tailscale up --login-server https://<tenant>.our-domain.com`).
