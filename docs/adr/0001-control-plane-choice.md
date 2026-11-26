# ADR-0001: Use Headscale as the Tailscale control plane

**Status:** Accepted
**Date:** 2026-10-23

> Note (2026-11-26): the Headscale mode was removed (ADR-0040). The coordinator is the only control plane.

## Context

We build a service ("atproto-tailnet"). Users log in with their AT Protocol identity (Bluesky handle / DID). Each user receives an isolated Tailscale-compatible mesh network (tailnet). We need an open-source Tailscale control server.

### Options considered

| Option | Pros | Cons |
|--------|------|------|
| **Headscale** | Only mature OSS Tailscale control server (38.5k stars, v0.29.1). Full Tailscale client compatibility. Active development. Well-structured Go codebase (~40K core LOC). | Single-tenant by design. Maintainers explicitly reject multi-tenancy (issues #2711, #1370, #2738). |
| **Netmaker** | Native multi-tenancy (v1.7 Organizations/Tenants). WireGuard-based. | Requires its own client (`netclient`). Stock Tailscale clients cannot connect. |
| **NetBird** | MSP-style multi-tenant management. WireGuard-based. | Requires its own client. Enterprise multi-tenant features can need a commercial license. |
| **Build from scratch** | We can design multi-tenancy natively. | Tailscale control protocol has no public documentation. We must implement Noise IK handshakes, netmap distribution, and DERP coordination. The effort is very large. |
| **ZeroTier / Nebula** | Mature mesh networking. ZeroTier supports multiple networks for each node. | The protocols are different and not Tailscale-compatible. |

### Why Tailscale compatibility matters

Tailscale has the largest install base of all mesh VPN products. Users already have the client on their machines. The `tailscale up --login-server` flag lets a Tailscale client use a custom control server. The client needs no modification. This network effect gives us a distribution advantage.

## Decision

We chose **Headscale** as the control plane. It is the only open-source implementation that speaks the Tailscale control protocol. Stock Tailscale clients work without modification. No other project offers Tailscale client compatibility and open-source availability together.

## Consequences

- We inherit the single-tenant limitation of Headscale (see ADR-0002 for our solution).
- We track Headscale releases for security patches and protocol compatibility.
- We use the existing OIDC support, ACL engine, and DERP relay handling of Headscale.
- Users connect with stock Tailscale clients (`tailscale up --login-server https://<tenant>.our-domain.com`).
