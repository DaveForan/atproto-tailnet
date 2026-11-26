---
title: Home
---

# atproto-tailnet

Private mesh networks with AT Protocol identity.

**atproto-tailnet** is a platform for isolated mesh networks (tailnets). Users sign in with a [Bluesky](https://bsky.app) / AT Protocol identity (`@handle`). There are no passwords and no accounts to manage.

An instance is invite-only. The instance operators get tailnets, and they can let other people create tailnets. Tailnet admins invite people by handle or DID. Other people can request to join the default tailnet of the instance. You can also manage your tailnets from Claude through the remote MCP server.

The code also contains a federation protocol between networks. It is off by default, because it does not carry traffic in the coordinator stack yet.

<div class="card-grid" markdown="0">
  <a href="guides/quickstart" class="card" style="text-decoration:none;color:inherit">
    <h3>Quickstart</h3>
    <p>Start a local instance in less than 10 minutes.</p>
  </a>
  <a href="guides/coordinator" class="card" style="text-decoration:none;color:inherit">
    <h3>The Coordinator</h3>
    <p>Deploy the Rust mesh coordinator for production.</p>
  </a>
  <a href="guides/mcp" class="card" style="text-decoration:none;color:inherit">
    <h3>Connect Claude</h3>
    <p>Manage your tailnets from Claude with the remote MCP server.</p>
  </a>
  <a href="guides/federation" class="card" style="text-decoration:none;color:inherit">
    <h3>Federation (off by default)</h3>
    <p>The design and status of links between networks.</p>
  </a>
  <a href="guides/deployment" class="card" style="text-decoration:none;color:inherit">
    <h3>Deployment</h3>
    <p>Deploy to Hetzner, Vultr, DigitalOcean, or AWS with automated orchestration.</p>
  </a>
  <a href="guides/managing-your-network" class="card" style="text-decoration:none;color:inherit">
    <h3>Managing Your Network</h3>
    <p>Invitations, roles, devices, ACLs, security, and instance administration.</p>
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

1. **Sign in with your AT Protocol handle** --- Your Bluesky identity (`@you.bsky.social` or a custom domain) is your login. You do not need new credentials.

2. **Get access** --- An instance operator (`OPERATOR_DIDS`) gets a private WireGuard-based mesh network at the first sign-in. A tailnet creator that an operator designates can also create one. Other people see their invitations, or they request to join the default tailnet.

3. **Invite members** --- Invite other AT Protocol users by handle or DID. The dashboard gives you an invitation link to share. The service sends nothing by itself.

4. **Connect devices** --- Members generate pre-authentication keys. Then they connect their devices with any Tailscale-compatible client. Each device receives a stable IP in the `100.64.0.0/10` CGNAT range. Traffic flows peer-to-peer through encrypted WireGuard tunnels. You can require approval for new devices.

5. **Manage from Claude (optional)** --- Add `https://<APP_DOMAIN>/mcp` as a custom connector in Claude. Claude signs in as you and has your permissions.

## Control plane

The control plane is one Rust coordinator for all tailnets:

| | Coordinator |
|---|---|
| **Backend** | Single Rust binary |
| **Protocol** | Noise IK + HTTP/2 |
| **Multi-tenant** | Native, in-process |
| **Federation** | Off by default (no traffic yet) |
| **Dependencies** | PostgreSQL or SQLite, Caddy |
| **Resource usage** | ~16 MB per instance |

The service does not use Docker to manage tailnets. See the [coordinator guide](guides/coordinator).
