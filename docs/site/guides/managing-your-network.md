---
title: Managing Your Network
---

# Managing Your Network

This guide describes the daily operations in the dashboard: devices, members, permissions, security, and networking.

## Who gets a tailnet

The instance is invite-only:

- An instance operator (a DID in `OPERATOR_DIDS`) gets a tailnet at the first sign-in.
- A "tailnet creator" that an operator designates can create one tailnet.
- Each other person who signs in gets a "no access" view. The view shows their pending invitations. If the instance has a default tailnet that accepts join requests, the view also shows **Request to join**.

When an operator designates you as a tailnet creator, you can create your tailnet in one of these ways:

- If you are not a member of a tailnet, sign out and sign in again. The service then creates your tailnet.
- Use the API (`POST /api/tenants/mine`) or the MCP tool `create_tailnet`.

### Give a web application a secure address

A web application on one of your devices can get an address such as `https://food-app.ts.example.com`. The address works inside the tailnet only, and it has a valid certificate.

1. Open the **Services** page and add a service: select the device, type the port, and give it a name.
2. Select **This is a web application: give it a secure web address**.
3. On your private board, the address works on your own devices. On the public board, it works for members after the approval and after they select **Connect**.

The application must listen on the tailnet address of the device (or on all addresses), not only on `localhost`.

The application receives two headers that tell it who is calling: `X-Tailnet-User` (the sign-in name) and `X-Tailnet-Device` (the name of the device). A visitor cannot set these headers.

A person who is not allowed to see the service gets the same answer as for a name that does not exist. From the public internet the address does not work.

If you do not see the option, the instance does not run the gateway.

### Lock sign-in to your devices

You can limit sign-in to devices that you trust. Open the **Account** page.

1. Select **Trust this device and turn the lock on**. The browser makes a key that it keeps and does not show to anybody. The service stores only the public part.
2. Save the recovery codes. The service shows them one time.
3. From now on, a sign-in from another device is refused, also with the correct AT Protocol account. You get a notification.

To add a device: sign in on it and select **Ask for approval**. It shows a code. On a trusted device, open **Account**, type the code, and select **Approve**. You can set the maximum number of trusted devices.

If you lose all trusted devices, use a recovery code. Each code works one time. Then you must trust the device that you use. If you have no code, a person with access to the server can reset the lock with `node dist/scripts/reset-device-lock.js <handle>` in the app container.

The key and a device cookie are in the data of the browser. A sign-in needs the two. If you clear the data or the cookies of the browser, the device is not trusted any more. Approve it again from another trusted device, or use a recovery code.

If a trusted device signs in from a browser that looks different (another system, another browser), the sign-in works but the **Account** page shows a warning on that device and you get a notification. If it was not you, remove the device. If it was you, select **This was me**.

### Lock your tailnet devices

You can limit your devices in a tailnet to the machines that you have now. Open the **Devices** page and find **Lock my devices**.

1. Select **Lock to my devices** and select the devices that stay. The other devices of yours are removed from the tailnet.
2. While the lock is on, no other machine can join as you. A valid auth key or the correct sign-in does not help.
3. To add a device, select **Allow one new device** and connect the device in the next 10 minutes. Only one device gets in.

The card shows the machines that were refused. If you have trusted devices, each change of this lock needs a trusted device.

### Appearance

Select a colour theme on the **Account** page. The theme is saved in the browser.

### What sign-in can access

Sign-in asks your AT Protocol server for one thing: proof of who you are (the `atproto` scope). The service cannot read or write your posts, follows, messages or settings. The service revokes the sign-in token as soon as it knows your account, and it keeps no token for your account. Your handle, display name and avatar come from public sources.

Your session in the dashboard is a cookie of this service. It stays valid for 7 days.

## Dashboard overview

The dashboard is a React 19 single-page application. It is served at the root URL of your instance. Your permissions control which pages and settings sections you see.

The menu has one entry for each page:

- **Overview** -- Health of the control server, device and member counts, the tailnet address, and every request that waits for your answer (invitations, devices that wait to be admitted, join requests, friend and share requests). Services that wait for approval have their own queue: **Services → Approval queue**
- **Devices** -- The devices, adding a device, who can reach your devices, the lock on your devices, auth keys
- **People** -- Members and their roles, invitations
- **Services** -- The public board, your private board, the controller board
- **Sharing** -- Friends and device shares
- **Settings** -- Sections for administrators: Security, Limits, Notifications, Roles, Access rules, Relays, Routes, Agent tokens, Sub-collectives, Audit log. You see only the sections that your permissions allow. With `FEDERATION_ENABLED=true` there are also Federation, Traversal policy and Credentials
- **Account** -- Trusted devices, the colour theme, the connector URL for Claude. See [Connect Claude (MCP)](mcp)
- **Instance** (instance operators only) -- Tailnets, users, settings, tailnet creators, activity log. See [Instance administration](#instance-administration)

The number next to **Overview** counts the requests that wait for you.

The header has a notification bell. It shows approval requests and limit hits for the current tailnet.

## Inviting members

An invitation is the allow-list entry for one person. The service does not send anything. You share the link.

1. Open the **People** page and find **Invite someone**.
2. Enter a handle (for example, `alice.bsky.social`) or a DID (`did:plc:...` or `did:web:...`).
3. Copy the invitation link (`https://<APP_DOMAIN>/invite/<id>`).
4. Send the link to the invitee by any channel.
5. The invitee opens the link and signs in. The invitee then accepts or declines.

After acceptance, the invitee becomes a member with the default role ("citizen"). Only the invitee can see the invitation. Other users get "not found". Pending invitations also show in the no-access view of the invitee.

You can revoke an invitation before the invitee accepts it. Lockdown mode blocks new invitations and acceptances. If the tailnet has a member limit, acceptance fails when the tailnet is full.

### Join requests

Join requests are an alternative to invitations. Turn on `allowJoinRequests` under **Settings → Security**. Then:

- A signed-in person can visit `https://<APP_DOMAIN>/join/<your-slug>` and submit a request.
- Requests appear on the **Overview** page for approval (the `approve_joins` permission is necessary). Approvers get a notification.
- Lockdown mode blocks new join requests.

The default tailnet of the instance accepts join requests automatically. People with no access see its **Request to join** button.

Join requests have these limits:

- A tailnet can have 50 pending requests.
- A person can have one pending request for each tailnet.
- After a rejection, the person must wait 24 hours before a new request.

## Roles and permissions

Every network has two built-in roles:

- **Originator** -- The creator of the network. The originator has all permissions. Nobody can kick or demote the originator. This is a hard identity (`isOriginator` flag), not only a role assignment.
- **Citizen** -- The default role for new members. You can customize the permissions of this role.

### Custom roles

Create custom roles with any combination of 17 permissions:

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
| `manage_sub_collectives` | Create and manage sub-collectives |

Assign roles to members on the **People** page. The effective permissions of a member are the union of the permissions of the role of that member.

## Boards and sharing

A tailnet has three boards.

| Board | Who sees it | What it contains |
|---|---|---|
| Controller board | Anybody on the internet | Text from the originator about the tailnet |
| Public board | Members of the tailnet | Services that members offer |
| Private board | You only | Services that you run for your own devices |

### Device access

In a new tailnet, a device can reach only the other devices of its owner. Two things open more access: a service on the public board, and a share between friends. The originator, or a member with the `manage_acl` permission, can change the tailnet to open access (each device reaches each other device) on the **Services** page.

### Offer a service

1. Open the **Services** page and go to **Add a service**.
2. Select the board, one of your devices, and one port. Give a title.
3. A service on the private board is active at once. A service on the public board waits in **Services → Approval queue** until an operator of the tailnet approves it (the originator, or a member with `approve_services`). The originator can turn this approval off under **Services → Board settings** (**Approve services before they show**); a new public service then shows on the board immediately.

A service offers only its one port. Other ports of the device stay private.

### Connect to a service

On the public board, select **Connect** next to a service and select one or more of your devices. Those devices can then reach that one port. You can disconnect at any time. If the author removes the service, or an operator withdraws the approval, all devices lose the access at once.

### Friends and shares

Use the **Sharing** page to share a device with one member.

1. Send a friend request. The other member accepts it.
2. Offer one of your devices, or ask for a device of your friend. Give the ports and how long the share lasts.
3. The share is active only after the other member accepts it. Until then nothing is open.

Each of you can end a share at any time. If you remove a friend, all shares between you end. You can block a member; a blocked member cannot send you friend requests. Operators cannot see or change the shares of other members.

### Controller board

The originator writes the public page of the tailnet on the **Services** page. The text can have headings, lists, bold, italic and `https://` links. HTML and scripts are shown as text. The page is at `/board/<tailnet-address>`. The sign-in page shows the controller board of the default tailnet.

## Device management

### Connecting devices

Members generate **pre-authentication keys** on the **Devices** page (**Add a device**). A key authorizes a Tailscale client to join the network:

```bash
tailscale up --login-server=https://control.yourdomain.com \
             --authkey=tskey-auth-XXXXX
```

The **Devices** page shows the exact command. In coordinator mode with `CONTROL_DOMAIN` set, all tailnets use one login server. The key selects the tailnet. Without `CONTROL_DOMAIN`, and in legacy Headscale mode, each tailnet has its own login server at `https://<tailnet-address>.<BASE_DOMAIN>`.

The device belongs to the member who made the key.

### Sign in a device without a key

A device can also join without a key. Start the Tailscale app with the login server of the instance and select **Sign in**. The app opens a page of this service. Sign in with your AT Protocol account, check the name of the device and the key fingerprint, select the tailnet, and select **Add device**. The link is valid for 10 minutes and works one time.

This is the first method on **Devices → Add a device**, with the server address to copy. It is the easy method for phones and for people who do not use a terminal.

A person who is not yet a member sees their invitation on that same page. They accept it and then add the device. Without an invitation, they can ask to join; after the approval, they start the sign-in on the device again.

When you select **Add device** on that page, you admit that one device. In a tailnet where approvers also admit new devices, the device then waits for an approver and connects by itself afterwards.

### Tailnet address

Each tailnet has a public address, for example `quiet-harbor-4821.ts.yourdomain.com`. Join links and board links use it. A new tailnet gets a random address. The address never contains your handle.

The originator can change the address on the **Overview** page (**Tailnet address**):

- The old address stays active as an alias. Devices and links that use it continue to work.
- A tailnet can have a maximum of 5 active addresses.
- You can retire an alias. Devices that still use a retired address lose their connection. A retired address stays reserved for 30 days.

### Auth keys

The service records each key that it issues. The **Devices** page lists the keys:

- A member sees the keys that the member made.
- A member with `manage_devices` (and the originator) sees all keys.
- You can revoke a key that is not used yet.

### Every new device waits for admission

A new device has no access until its owner admits it. This is on for every member, and for the originator too. Each member can turn it off for their own devices only (see below); nobody can turn it off for another member or for the whole tailnet.

- **A device that signs in** (see above): you admit it on the sign-in page, where you see its name, system and key fingerprint.
- **A device that uses an auth key**: the key only registers the device. The device then shows on the **Overview** page under **Devices waiting to be admitted**. Check the name and the fingerprint, and select **Admit**. Select **Refuse** for a device that you do not know: it is removed.
- **Only the owner admits a device.** The originator and the approvers cannot admit the device of another member in the owner's place.
- While a device waits, no device can reach it and it can reach no device. The relay refuses it.
- **You get a notification** when a device is added with one of your keys and waits. If you do not know the device, refuse it and revoke your keys.
- **A waiting device expires.** If nobody admits it in one week, it is removed. The originator can set another time, from one hour to one year, under **Settings → Limits** (`waitingDeviceHours`). A removed device can be added again.

The key fingerprint is the short form of a key that the Tailscale app makes on the device. It identifies that one installation. The name and the system come from the device and can be false.

#### Your own approval

**Devices → Access → Protection of my devices** has the switch **Approve each new device**. It is on by default.

- While it is off, a device that you add with one of your keys has access at once. Anyone who gets your key can then add a device. A sign-in on the device still asks you first.
- The switch applies to your devices only. No admin can change it for you.
- While the tailnet has the second approval, the switch is on and locked for every member.

#### Invalidate devices and keys

To cut off one device, remove it on the **Devices** page. To stop one key, revoke it under **Issued keys**. To cut off everything at once, select **Invalidate all my devices and keys** in **Protection of my devices**: all your devices in this tailnet lose access and all your keys stop working. You stay a member and can add devices again.

The originator, or a member with `manage_devices`, can do the same for any member: **People → Invalidate devices**.

#### Second approval

The originator can add a second approval: turn on **Approvers also admit new devices** (**Settings → Security**, setting `requireDeviceApproval`). Then:

- After the owner admits a device, it waits for an approver: the originator, or a member with the `approve_devices` permission.
- The approvers get a notification. They admit or refuse the device on the **Overview** page.
- An approver cannot approve their own device. The device of an approver, and of the originator, waits for a different approver. If the tailnet has only one approver, the devices of that person need no second approval.
- Every member must admit their own devices. Nobody can turn their own approval off, and each choice is set back to on.

In legacy Headscale mode there is no admission step. There the setting has its older meaning: a request for a key waits for an approver.

### Device and member limits

The originator can set `maxDevices` and `maxMembers` under **Settings → Limits** (0 = unlimited). There are no plans. The service enforces the limits:

- Devices: when it issues a key and when it approves a device.
- Members: when an invitee accepts and when an approver approves a join request.

When a limit stops an action, the service notifies the originator. A sub-collective cannot have higher limits than its parent.

### Removing a member

When you remove (kick) a member, the service also revokes the auth keys of the member and deletes the devices of the member. You need the `kick` permission. Nobody can remove the originator.

### Device locking

Device locks bind a membership to specific machine keys:

- After you lock a member, the member cannot generate new auth keys until you unlock the member.
- A lock prevents a compromised account from adding rogue devices.
- You need the `lock_devices` permission to manage locks.

### Node operations

On the Devices page, members with the `manage_devices` permission can do these tasks:

- View all connected devices and their online status
- Remove devices from the network

Each member can remove their own devices.

## Notifications

The service makes a notification for these events:

- A device approval request
- A join request
- A service approval request
- A limit hit

The recipients are the originator and the members with the matching `approve_*` permission. The bell in the header shows them.

### Webhook

You can also send each notification to a webhook, for example a self-hosted ntfy, Gotify, or a Matrix bridge. Under **Settings → Notifications**, set the webhook URL and a secret (the `manage_settings` permission is necessary). Then:

- Each request has an HMAC-SHA256 signature of the body in the `X-Atproto-Tailnet-Signature` header. Use the secret to check it.
- The URL must use `https` and resolve to a public address. The instance operator can allow private addresses with `WEBHOOK_ALLOW_PRIVATE=true` (single-organisation instances only).
- The service does not follow redirects.
- Use **Send test** to check the webhook.

## Access control (ACL)

**Settings → Access rules** provides a policy editor. The policy controls which devices can talk to each other. The policy uses the Tailscale ACL format.

In **coordinator mode** (the default), the coordinator has no users, groups or tags. The service accepts only `accept` rules with `*`, IP addresses, CIDRs or host aliases. It refuses `groups`, `tagOwners` and `autoApprovers`:

```json
{
  "hosts": {
    "server1": "100.64.0.1"
  },
  "acls": [
    {
      "action": "accept",
      "src": ["100.64.0.0/10"],
      "dst": ["server1:80,443"]
    }
  ]
}
```

In **legacy Headscale mode**, the full Headscale policy is available:

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

An **exit node** routes all internet traffic of a device through another device on the network. Devices advertise the exit node capability. A member with `manage_devices` approves or withdraws the capability in the Routes tab.

### Subnet routers

**Subnet routers** advertise access to physical network subnets (for example, `192.168.1.0/24`). Network members can then reach devices on a LAN. You do not install Tailscale on each device. As with exit nodes, a member with `manage_devices` must approve subnet routes. Until then, the route has no effect.

### IP ranges

Each network receives a default IP range in the CGNAT space (`100.64.0.0/10` for IPv4, `fd7a:115c:a1e0::/48` for IPv6). You can change these ranges under **Settings → IP ranges** (Headscale mode only). You can choose these settings:

- IPv4 prefix and size
- IPv6 prefix and size
- Allocation strategy: sequential or random

When you change IP ranges, you must restart the control plane. You must also register all devices again.

### DERP relays

DERP relays provide encrypted relay connectivity when direct peer-to-peer connections fail (for example, behind restrictive NATs). In coordinator mode, the default is the built-in relay of the instance (see the [coordinator guide](coordinator#derp-map)). No traffic goes through Tailscale relays. Under **Settings → Relays** you can do these tasks:

- Add custom relay regions (IDs 900-999)
- Enable or disable the default relays (the built-in relay in coordinator mode; the public Tailscale relays in legacy Headscale mode)
- Toggle the embedded DERP server (legacy Headscale mode only)

The settings apply to your tailnet only. In coordinator mode, connected devices get the new relay map at once.

## Agent tokens

Agent tokens give programmatic API access to automation, CI/CD, and AI agents:

- Tokens have the prefix `at_`. The system stores them as SHA-256 hashes.
- Each token applies to a single tenant and to a subset of permissions.
- Expiry is mandatory (maximum 365 days).
- The system resolves tokens at request time. When you revoke a token or disable the `allowAgentTokens` toggle, the change takes effect immediately.

Create tokens under **Settings → Agent tokens**. The dashboard shows the token value once, when you create the token.

### Using agent tokens

```bash
curl https://yourdomain.com/api/tenants/<id>/devices \
  -H "Authorization: Bearer at_XXXXX"
```

An agent token can access each endpoint that its permission scope allows. The token is restricted to its tenant. It never gives instance operator powers.

To use the API from Claude, use the MCP server, not an agent token. See [Connect Claude (MCP)](mcp).

## Security settings

**Settings → Security** controls the security toggles for the whole tenant. The switch for the public board is on the **Services** page. The API has all of these settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `requireDeviceApproval` | off | Approvers also admit each new device, after its owner. Every new device waits for its owner in all cases |
| `requireServiceDeviceApproval` | off | Gate service device registrations |
| `requireServiceApproval` | on | A new or changed public service waits in the approval queue. Off: it shows on the board immediately |
| `allowJoinRequests` | off | Enable public join request page (on for the default tailnet) |
| `allowAgentTokens` | off | Enable API token creation |
| `allowMemberAgentTokens` | off | Allow non-originators to create tokens |
| `boardEnabled` | off | Enable the public service board |
| `notificationWebhookUrl` | --- | Webhook for notifications. See [Webhook](#webhook) |

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

The system logs each security-relevant action to the audit trail. You can view the trail under **Settings → Audit log** (the `view_audit_log` permission is necessary). The system logs these actions:

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

The **Overview** page shows the current number of devices and members, with the limit when one is set. The originator sets the limits under **Settings → Limits**. See [Device and member limits](#device-and-member-limits).

The system stores usage snapshots in the `usage_snapshots` table (the health monitor samples every 5 minutes). `GET /api/tenants/:id/usage` returns 7 days of them; the dashboard does not show the history.

## Instance hibernation

To save resources, the system can stop idle networks automatically:

- Set `hibernateAfterDays` under **Settings → Security** (0 = disabled). Headscale mode only: the coordinator has no instance to stop.
- The system updates `lastActivityAt` on API access (debounced to avoid write amplification).
- The health monitor sweeps all tenants. It stops each tenant that is idle longer than the threshold.
- To start a stopped network again, the originator uses **Start** (`POST /api/tenants/:id/start`).

## Instance administration

The **Instance** page is visible only to instance operators. It has these functions:

- **Tailnets**: All tailnets on the instance. An operator can suspend, unsuspend or delete a tailnet.
- **Users**: All users who signed in. An operator can disable or enable a user.
- **Settings**: The default tailnet and single-tailnet mode.
- **Tailnet creators**: Add or remove the people (handle or DID) who can create a tailnet.
- **Activity log**: The instance-level audit trail.

### Suspend a tailnet

Suspension stops a tailnet without deleting it:

- The suspension also applies to all sub-tailnets of the tailnet.
- In coordinator mode, the coordinator enforces it. Devices cannot register or get map updates.
- Members get an error (`tenant_suspended`) on each request to the tailnet.
- **Unsuspend** restores the tailnet and the sub-tailnets that the suspension included.

### Disable a user

A disabled user cannot sign in. Each credential of the user stops working, including agent tokens and MCP connections. The service also does these steps:

- It removes the user from each tailnet where the user is a member, with their devices and keys.
- In the tailnets that the user owns, it deletes the devices and keys of the user. The tailnets stay.
- It cancels the pending join requests and invitations of the user.

**Enable** lets the user sign in again. The removed memberships do not come back.

### Default tailnet and single-tailnet mode

The first tailnet that an operator creates becomes the default tailnet. It accepts join requests. When you select a different default tailnet, the service turns on join requests for it. Select **None** to have no default tailnet. People with no access then see only their invitations.

In single-tailnet mode, the instance has only one top-level tailnet. Nobody can create a second one, and nobody can create sub-collectives. You cannot turn on this mode when more than one top-level tailnet exists.
