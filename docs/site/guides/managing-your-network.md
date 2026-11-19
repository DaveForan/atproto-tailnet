---
title: Managing Your Network
---

# Managing Your Network

After the system provisions your tailnet, the dashboard gives you tools to manage devices, members, permissions, security, and networking. This guide describes the daily operations.

## Dashboard overview

The dashboard is a React 19 single-page application. It is served at the root URL of your instance. It has 20 lazy-loaded tabs. Your permissions control which tabs you see:

**Status** -- Network health, node count, member count, provisioning status

**Devices** -- Connected nodes, online status, auth key generation

**Members** -- Current members and their roles

**Connect** -- Generate auth keys and connect new devices

**Invite** -- Send invitations by AT Protocol handle

**Roles** -- Custom role definitions and permission assignments

**ACL** -- Access control lists (groups, hosts, tag owners, firewall rules)

**Routes** -- Exit nodes and subnet routers

**DERP** -- Custom relay configuration

**IP Ranges** -- IPv4/IPv6 prefix configuration

**Services** -- Service registry and approval

**Board** -- Public service board

**Federation** -- Federation links and posture management

**Collectives** -- Sub-collective hierarchy management

**Traversal** -- Cross-network traversal policy editor

**Agents** -- API token management for automation

**Credentials** -- Verifiable credential issuance and verification

**Usage** -- Metering, plan limits, snapshot history

**Security** -- Tenant settings, lockdown, device approval toggles

**Audit** -- Complete audit log of security-relevant actions

## Inviting members

Members join your network with their AT Protocol handle:

1. Go to the **Invite** tab.
2. Enter the handle (for example, `alice.bsky.social`).
3. The invitee receives an invitation. The invitee can accept it in the web UI.
4. After acceptance, the invitee becomes a member with the "citizen" role.

You can revoke an invitation before the invitee accepts it. The **Join Requests** feature is an alternative. You enable it with a toggle in the Security tab. It provides a public `/join/<slug>` URL where users can request to join. An operator must approve each request.

### Join requests

When `allowJoinRequests` is enabled:

- Anyone can visit `https://yourdomain.com/join/<your-slug>` and submit a join request.
- Requests appear in the dashboard for approval (the `approve_joins` permission is necessary).
- Lockdown mode blocks new join requests.

## Roles and permissions

Every network has two built-in roles:

- **Originator** -- The creator of the network. The originator has all permissions. Nobody can kick or demote the originator. This is a hard identity (`isOriginator` flag), not only a role assignment.
- **Citizen** -- The default role for new members. You can customize the permissions of this role.

### Custom roles

Create custom roles with any combination of 16 permissions:

| Permission | Description |
|-----------|-------------|
| `invite` | Send invitations to new members |
| `kick` | Remove members from the network |
| `manage_roles` | Create, edit, and delete roles and assign them |
| `manage_settings` | Change tenant settings (posture, hibernation, and others) |
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
| `manage_agent_tokens` | Revoke the API tokens of any member |
| `manage_acl` | Edit ACL policy and DERP configuration |

Assign roles to members in the **Members** tab. The effective permissions of a member are the union of the permissions of the role of that member.

## Device management

### Connecting devices

Members generate **pre-authentication keys** in the Devices tab. Each key is a one-time-use token. The token authorizes a Tailscale client to join the network:

```bash
tailscale up --login-server=https://<slug>.ts.yourdomain.com \
             --authkey=tskey-auth-XXXXX
```

### Device approval

When `requireDeviceApproval` is enabled (Security tab):

- A new device connection creates a pending approval entry.
- A user with the `approve_devices` permission must approve the entry before the device receives a key.
- Rejected devices cannot connect.

### Device locking

Device locks bind a membership to specific machine keys:

- After you lock a member, the member cannot generate new auth keys until you unlock the member.
- A lock prevents a compromised account from adding rogue devices.
- You need the `lock_devices` permission to manage locks.

### Node operations

In the Devices tab, operators with the `manage_devices` permission can do these tasks:

- View all connected devices and their online status
- Rename devices
- Remove devices from the network

## Access control (ACL)

The ACL tab provides a policy editor. The policy controls which devices can talk to each other. The policy uses the Tailscale ACL format:

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

Changes take effect immediately when you save them.

## Networking

### Exit nodes

An **exit node** routes all internet traffic of a device through another device on the network. Devices advertise the exit node capability. The network operator approves or denies the capability in the Routes tab.

### Subnet routers

**Subnet routers** advertise access to physical network subnets (for example, `192.168.1.0/24`). Network members can then reach devices on a LAN. You do not install Tailscale on each device. As with exit nodes, an operator must approve subnet routes.

### IP ranges

Each network receives a default IP range in the CGNAT space (`100.64.0.0/10` for IPv4, `fd7a:115c:a1e0::/48` for IPv6). You can change these ranges in the IP Ranges tab. You can choose these settings:

- IPv4 prefix and size
- IPv6 prefix and size
- Allocation strategy: sequential or random

When you change IP ranges, you must restart the control plane. You must also register all devices again.

### DERP relays

DERP relays provide encrypted relay connectivity when direct peer-to-peer connections fail (for example, behind restrictive NATs). By default, the network uses the public Tailscale relays. In the DERP tab you can do these tasks:

- Add custom relay regions (IDs 900-999)
- Toggle the embedded DERP server
- Enable or disable public Tailscale relays

## Agent tokens

Agent tokens give programmatic API access to automation, CI/CD, and AI agents:

- Tokens have the prefix `at_`. The system stores them as SHA-256 hashes.
- Each token applies to a single tenant and to a subset of permissions.
- Expiry is mandatory (maximum 365 days).
- The system resolves tokens at request time. When you revoke a token or disable the `allowAgentTokens` toggle, the change takes effect immediately.

Create tokens in the **Agents** tab. The dashboard shows the token value once, when you create the token.

### Using agent tokens

```bash
curl https://yourdomain.com/api/tenants/<id>/nodes \
  -H "Authorization: Bearer at_XXXXX"
```

An agent token can access each endpoint that its permission scope allows. The token is restricted to its tenant.

## Security settings

The **Security** tab controls the security toggles for the whole tenant:

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

Lockdown is an emergency switch. It immediately blocks these actions:

- New invitations
- Invitation acceptance
- Auth key generation
- Agent token creation
- Join requests
- Federation activity (inbound and outbound)

Lockdown does not disconnect existing devices. It does not revoke existing tokens. It prevents the grant of any new access.

## Audit log

The system logs each security-relevant action to the audit trail. You can view the trail in the **Audit** tab (the `view_audit_log` permission is necessary). The system logs these actions:

- Member joins, leaves, and role changes
- Device approvals, locks, and removals
- Invitation creates, accepts, and revokes
- Tenant settings changes
- ACL policy updates
- Agent token creates and revokes
- Federation link actions
- Lockdown toggles
- Tenant lifecycle (start, stop, delete)

Each audit entry includes the user ID of the actor, the timestamp, the action type, and relevant metadata.

## Usage and limits

The **Usage** tab shows these items:

- **Live counts**: Current devices, members, and services
- **Plan limits**: Maximum devices and members (you can configure them with the API)
- **7-day history**: 168 data points (the health monitor samples every 5 minutes)

The system stores usage snapshots in the `usage_snapshots` table. The dashboard shows them as a sparkline chart.

## Instance hibernation

To save resources, the system can stop idle networks automatically:

- Set `hibernateAfterDays` in the Security tab (0 = disabled).
- The system updates `lastActivityAt` on API access (debounced to avoid write amplification).
- The health monitor sweeps all tenants. It stops each tenant that is idle longer than the threshold.
- A hibernated network restarts on the next API access.
