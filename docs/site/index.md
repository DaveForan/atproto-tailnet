---
title: Home
---

# atproto-tailnet

Private mesh networks with AT Protocol identity and cross-network federation.

**atproto-tailnet** is a platform that gives every user their own isolated mesh network (tailnet), authenticated through their [Bluesky](https://bsky.app) / AT Protocol identity. Users sign in with their `@handle`, get a private network, and invite others --- no passwords, no accounts to manage.

Networks can optionally federate with each other through the Collective Federation Protocol, sharing routes across organizational boundaries while each side retains full control.

<div class="card-grid" markdown="0">
  <a href="guides/quickstart" class="card" style="text-decoration:none;color:inherit">
    <h3>Quickstart</h3>
    <p>Get a local instance running in under 10 minutes.</p>
  </a>
  <a href="guides/coordinator" class="card" style="text-decoration:none;color:inherit">
    <h3>Coordinator Mode</h3>
    <p>Deploy the Rust mesh coordinator for production.</p>
  </a>
  <a href="guides/federation" class="card" style="text-decoration:none;color:inherit">
    <h3>Federation</h3>
    <p>Connect networks across instances with signed route exchange.</p>
  </a>
  <a href="guides/deployment" class="card" style="text-decoration:none;color:inherit">
    <h3>Deployment</h3>
    <p>Deploy to Hetzner, Vultr, DigitalOcean, or AWS with automated orchestration.</p>
  </a>
  <a href="guides/managing-your-network" class="card" style="text-decoration:none;color:inherit">
    <h3>Managing Your Network</h3>
    <p>Roles, devices, ACLs, security, and day-to-day operations.</p>
  </a>
  <a href="reference/configuration" class="card" style="text-decoration:none;color:inherit">
    <h3>Configuration Reference</h3>
    <p>Every environment variable and config option.</p>
  </a>
  <a href="reference/architecture" class="card" style="text-decoration:none;color:inherit">
    <h3>Architecture</h3>
    <p>How the components fit together.</p>
  </a>
</div>

## How it works

1. **Sign in with your AT Protocol handle** --- Your Bluesky identity (`@you.bsky.social` or a custom domain) is your login. No new credentials needed.

2. **Get an isolated mesh network** --- On first login, the platform provisions a private WireGuard-based mesh network. Every member gets a stable IP in the `100.64.0.0/10` CGNAT range.

3. **Invite members by handle** --- Share your network by inviting other AT Protocol users. They authenticate the same way and join your mesh.

4. **Connect devices** --- Members generate pre-authentication keys and connect their devices using any Tailscale-compatible client. Traffic flows peer-to-peer over encrypted WireGuard tunnels.

5. **Federate (optional)** --- Link your network to others. The Collective Federation Protocol negotiates shared CIDR routes so devices across two networks can reach each other, with each side controlling what's exposed.

## Operating modes

The platform supports two control plane backends:

| | Coordinator (recommended) | Legacy Headscale |
|---|---|---|
| **Backend** | Single Rust binary | One Docker container per tenant |
| **Protocol** | Noise IK + HTTP/2 | Headscale gRPC-gateway |
| **Multi-tenant** | Native, in-process | Container isolation |
| **Federation** | Built-in CFP broker | Application-layer broker |
| **Dependencies** | PostgreSQL or SQLite, Caddy | PostgreSQL, Caddy, Docker socket |
| **Resource usage** | ~16 MB per instance | ~50 MB per tenant container |

New deployments should use coordinator mode. The legacy Headscale mode is maintained for existing installations.
