---
title: Managing Your Network
---

# Managing Your Network

Once your tailnet is provisioned, the dashboard provides tools for managing devices, members, permissions, security, and networking. This guide covers the day-to-day operations.

## Dashboard overview

The dashboard is a single-page application served at your instance's root URL. It has tabbed navigation across all management functions:

**Status** -- Network health, node count, member count, provisioning status

**Devices** -- Connected nodes, online status, auth key generation

**Members** -- Current members and their roles

**Invite** -- Send invitations by AT Protocol handle

**Roles** -- Custom role definitions and permission assignments

**ACL** -- Access control lists (groups, hosts, tag owners, firewall rules)

**Routes** -- Exit nodes and subnet routers

**DERP** -- Custom relay configuration

**IP Ranges** -- IPv4/IPv6 prefix configuration

**Services** -- Service registry and approval

**Board** -- Public service board

**Federation** -- Federation links and posture management

**Agents** -- API token management for automation

**Usage** -- Metering, plan limits, snapshot history

**Security** -- Tenant settings, lockdown, device approval toggles

**Audit** -- Complete audit log of security-relevant actions

## Inviting members

Members join your network by their AT Protocol handle:

1. Go to the **Invite** tab
2. Enter the handle (e.g., `alice.bsky.social`)
3. The invitee receives an invitation they can accept through the web UI
4. On acceptance, they become a member with the "citizen" role

Invitations can be revoked before acceptance. The **Join Requests** feature (toggle in Security tab) provides an alternative: a public `/join/<slug>` URL where users can request to join, subject to operator approval.

### Join requests

When `allowJoinRequests` is enabled:
- Anyone can visit `https://yourdomain.com/join/<your-slug>` and submit a join request
- Requests appear in the dashboard for approval (requires `approve_joins` permission)
- Lockdown mode blocks new join requests

## Roles and permissions

Every network has two built-in roles:

- **Originator** -- The network creator. Has all permissions, cannot be kicked or demoted. This is a hard identity (`isOriginator` flag), not just a role assignment.
- **Citizen** -- The default role for new members. Permissions are customizable.

### Custom roles

Create custom roles with any combination of 16 permissions:

| Permission | Description |
|-----------|-------------|
| `invite` | Send invitations to new members |
| `kick` | Remove members from the network |
| `manage_roles` | Create/edit/delete roles and assign them |
| `manage_settings` | Change tenant settings (posture, hibernation, etc.) |
| `approve_devices` | Approve pending device connections |
| `approve_joins` | Approve join requests |
| `approve_services` | Approve service registrations |
| `lock_devices` | Bind members to specific machine keys |
| `view_audit_log` | Read the audit trail |
| `manage_devices` | Manage nodes (rename, remove, routes) |
| `manage_services` | Register and manage services |
| `manage_board` | Moderate the public board |
| `create_posts` | Post to the public board |
| `create_agent_tokens` | Generate API tokens |
| `manage_agent_tokens` | Revoke any member's API tokens |
| `manage_acl` | Edit ACL policy and DERP configuration |

Assign roles to members from the **Members** tab. A member's effective permissions are the union of their role's permissions.

## Device management

### Connecting devices

Members generate **pre-authentication keys** from the Devices tab. These are one-time-use tokens that authorize a Tailscale client to join the network:

```bash
tailscale up --login-server=https://<slug>.ts.yourdomain.com \
             --authkey=tskey-auth-XXXXX
```

### Device approval

When `requireDeviceApproval` is enabled (Security tab):
- New device connections create a pending approval entry
- A user with `approve_devices` permission must approve before the device gets a key
- Rejected devices cannot connect

### Device locking

Device locks bind a membership to specific machine keys:
- Once locked, the member cannot generate new auth keys until unlocked
- Prevents a compromised account from adding rogue devices
- Requires `lock_devices` permission to manage

### Node operations

From the Devices tab, operators with `manage_devices` permission can:
- View all connected devices and their online status
- Rename devices
- Remove devices from the network

## Access control (ACL)

The ACL tab provides a policy editor for controlling which devices can talk to each other. The policy uses Tailscale's ACL format:

```json
{
  "groups": {
    "group:admins": ["alice.bsky.social"]
  },
  "hosts": {
    "server1": "100.64.0.1"
  },
  "acls": [
    {
      "action": "accept",
      "src": ["group:admins"],
      "dst": ["*:*"]
    },
    {
      "action": "accept",
      "src": ["*"],
      "dst": ["server1:80,443"]
    }
  ],
  "tagOwners": {
    "tag:server": ["group:admins"]
  }
}
```

Changes take effect immediately when saved.

## Networking

### Exit nodes

An **exit node** routes all of a device's internet traffic through another device on the network. Devices advertise exit node capability; the network operator approves or denies from the Routes tab.

### Subnet routers

**Subnet routers** advertise access to physical network subnets (e.g., `192.168.1.0/24`). This lets network members reach devices on a LAN without installing Tailscale on every device. Like exit nodes, subnet routes require operator approval.

### IP ranges

Each network gets a default IP range in the CGNAT space (`100.64.0.0/10` for IPv4, `fd7a:115c:a1e0::/48` for IPv6). You can customize these from the IP Ranges tab, choosing:

- IPv4 prefix and size
- IPv6 prefix and size
- Allocation strategy: sequential or random

Changing IP ranges requires a control plane restart and re-registration of all devices.

### DERP relays

DERP relays provide encrypted relay connectivity when direct peer-to-peer connections fail (e.g., behind restrictive NATs). By default, Tailscale's public relays are used. From the DERP tab you can:

- Add custom relay regions (IDs 900-999)
- Toggle the embedded DERP server
- Enable or disable public Tailscale relays

## Agent tokens

Agent tokens allow programmatic API access for automation, CI/CD, and AI agents:

- Tokens are prefixed with `at_` and stored as SHA-256 hashes
- Each token is scoped to a single tenant and a subset of permissions
- Mandatory expiry (maximum 365 days)
- Tokens are resolved at request time --- revoking a token or disabling the `allowAgentTokens` toggle takes effect immediately

Create tokens from the **Agents** tab. The token value is shown once on creation.

### Using agent tokens

```bash
curl https://yourdomain.com/api/tenants/<id>/nodes \
  -H "Authorization: Bearer at_XXXXX"
```

Agent tokens can access any endpoint their permission scope allows, restricted to their tenant.

## Security settings

The **Security** tab controls tenant-wide security toggles:

| Setting | Default | Description |
|---------|---------|-------------|
| `requireDeviceApproval` | off | Gate new device connections behind approval |
| `requireServiceDeviceApproval` | off | Gate service device registrations |
| `requireServiceApproval` | off | Gate service registrations |
| `allowJoinRequests` | off | Enable public join request page |
| `allowAgentTokens` | off | Enable API token creation |
| `allowMemberAgentTokens` | off | Allow non-originators to create tokens |
| `boardEnabled` | off | Enable the public service board |

### Lockdown mode

Lockdown is an emergency switch that immediately:

- Blocks all new invitations
- Blocks invitation acceptance
- Blocks auth key generation
- Blocks agent token creation
- Blocks join requests
- Blocks federation activity (inbound and outbound)

Lockdown does not disconnect existing devices or revoke existing tokens. It prevents any new access from being granted.

## Audit log

Every security-relevant action is logged to the audit trail, viewable from the **Audit** tab (requires `view_audit_log` permission). Logged actions include:

- Member joins, leaves, role changes
- Device approvals, locks, removals
- Invitation creates, accepts, revokes
- Tenant settings changes
- ACL policy updates
- Agent token creates, revokes
- Federation link actions
- Lockdown toggles
- Tenant lifecycle (start, stop, delete)

Audit entries include the actor's user ID, timestamp, action type, and relevant metadata.

## Usage and limits

The **Usage** tab shows:

- **Live counts**: Current devices, members, services
- **Plan limits**: Maximum devices, members (configurable via API)
- **7-day history**: 168 data points (sampled every 5 minutes by the health monitor)

Usage snapshots are stored in the `usage_snapshots` table and displayed as a sparkline chart.

## Instance hibernation

To save resources, idle networks can be automatically stopped:

- Set `hibernateAfterDays` in the Security tab (0 = disabled)
- `lastActivityAt` is updated on API access (debounced to avoid write amplification)
- The health monitor sweeps all tenants and stops any that have been idle past the threshold
- Hibernated networks restart on the next API access
