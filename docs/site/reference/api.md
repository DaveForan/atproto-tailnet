---
title: API Reference
---

# API Reference

The platform has two API surfaces: the **TypeScript service API** (for users, authenticated by session or token) and the **coordinator admin API** (internal, authenticated by bearer token).

## TypeScript service API

Base URL: `https://<APP_DOMAIN>`

Authentication: one of these credentials:

- A session cookie (browser).
- `Authorization: Bearer at_XXXXX` (agent token). An agent token applies to one tenant. It never gives operator powers.
- `Authorization: Bearer mcp_XXXXX` (MCP OAuth token). The REST API accepts an MCP token only from the `/mcp` tools of the same process. From any other caller it returns 401. See [Connect Claude (MCP)](../guides/mcp).

Rate limits: 10 req/min on `/auth` and `/.well-known`, 60 req/min on `/api`. The `/mcp` endpoint has its own limits for each IP address and for each user.

A request from a disabled user returns 403 with `code: "account_disabled"`. A member request to a suspended tenant returns 403 with `code: "tenant_suspended"`. A request from a person who is not a member returns 404 "Tenant not found".

### Public endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Service health check |
| `GET` | `/api/instance` | Default tailnet (`id`, `slug`, `name`, `acceptsJoinRequests`) or `null`, and `inviteOnly: true` |
| `GET` | `/.well-known/atproto-client-metadata.json` | AT Proto OAuth client metadata |
| `GET` | `/.well-known/jwks.json` | Public JWKS for OAuth |
| `GET` | `/collective/:slug/did.json` | Collective DID document |
| `GET` | `/api/tenants/by-slug/:slug/public` | Public tenant information for the join page |
| `GET` | `/join/:slug` | Public join request page |
| `GET` | `/invite/:id` | Invitation page. A visitor who is not signed in goes to sign-in first |
| `GET` | `/board/:slug` | Public service board |

### Authentication

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/auth/login?handle=<handle>` | Start AT Proto OAuth |
| `GET` | `/auth/callback` | OAuth callback |
| `POST` | `/auth/logout` | End session |

### User and tenant

| Method | Path | Permission | Description |
|--------|------|-----------|-------------|
| `GET` | `/api/me` | *signed in* | Current user. Includes `isOperator`, `canCreateTailnet`, `access` (`no_access` when the user has no membership), `instance.singleTailnet` and `features.federation` |
| `GET` | `/api/permissions` | *signed in* | All permission names |
| `POST` | `/api/tenants/mine` | operator or tailnet creator | Create your own top-level tailnet. Body: `{"name"?}`. 409 `already_has_tailnet`, 403 `cannot_create_tailnet`. Not for agent tokens |
| `GET` | `/api/tenants` | *signed in* | List tenants of the user |
| `GET` | `/api/tenants/:id` | *any member* | Tenant details |
| `DELETE` | `/api/tenants/:id` | *originator* | Delete tenant. Not for agent tokens |
| `POST` | `/api/tenants/:id/start` | *originator* | Start tenant instance |
| `POST` | `/api/tenants/:id/stop` | *originator* | Stop tenant instance |
| `GET` | `/api/tenants/:id/health` | *any member* | Live health probe |

### Members and invitations

| Method | Path | Permission | Description |
|--------|------|-----------|-------------|
| `GET` | `/api/tenants/:id/members` | *any member* | List members |
| `DELETE` | `/api/tenants/:id/members/:userId` | `kick` | Remove member. Also revokes the auth keys and deletes the devices of the member |
| `PUT` | `/api/tenants/:id/members/:userId/role` | `manage_roles` | Change the role of a member |
| `POST` | `/api/tenants/:id/invitations` | `invite` | Create invitation. Body: exactly one of `{"handle"}` or `{"did"}`. The response contains `inviteUrl` |
| `GET` | `/api/tenants/:id/invitations` | `invite` | List invitations of the tenant |
| `DELETE` | `/api/tenants/:id/invitations/:invitationId` | `invite` | Revoke invitation |
| `GET` | `/api/invitations` | *signed in* | Pending invitations for the current user |
| `GET` | `/api/invitations/:invitationId` | *invitee* | One invitation. Other users get 404 |
| `POST` | `/api/invitations/:invitationId/accept` | *invitee* | Accept invitation |
| `POST` | `/api/invitations/:invitationId/decline` | *invitee* | Decline invitation |

The service does not send invitations. Copy the `inviteUrl` (`https://<APP_DOMAIN>/invite/<id>`) and give it to the invitee.

### Join requests

| Method | Path | Permission | Description |
|--------|------|-----------|-------------|
| `POST` | `/api/tenants/:id/join-requests` | *signed in, not a member* | Request to join. Body: `{"message"?}` |
| `GET` | `/api/tenants/:id/join-requests/mine` | *signed in* | Status of your own request |
| `GET` | `/api/tenants/:id/join-requests` | `approve_joins` | List requests |
| `POST` | `/api/tenants/:id/join-requests/:requestId/approve` | `approve_joins` | Approve request |
| `POST` | `/api/tenants/:id/join-requests/:requestId/reject` | `approve_joins` | Reject request |

Join request limits:

- A tenant can have 50 pending requests. More requests return 429 `join_queue_full`.
- A person can have one pending request for each tenant (409 `join_request_pending`).
- After a rejection, the person must wait 24 hours (429 `join_cooldown`).

### Devices and auth keys

| Method | Path | Permission | Description |
|--------|------|-----------|-------------|
| `GET` | `/api/tenants/:id/devices` | *any member* | List devices |
| `POST` | `/api/tenants/:id/devices/auth-key` | *any member* | Generate a pre-auth key. A key registers a device; the device then waits for admission |
| `GET` | `/api/tenants/:id/devices/waiting` | *any member* | Devices that wait for admission: `mine`, and `queue` for approvers. Each has `canAdmit` (the caller may take its next step) and `expiresAt` (when it is removed if nobody admits it) |
| `POST` | `/api/tenants/:id/devices/:nodeId/admit` | owner of the device, then `approve_devices` | Admit a waiting device. Session only, step-up |
| `POST` | `/api/tenants/:id/devices/:nodeId/refuse` | owner of the device, or `approve_devices` | Refuse and remove a waiting device. Session only |
| `GET` | `/api/tenants/:id/device-approval/mine` | *any member* | The caller's own approval of new devices: `{on, locked, needsApprover}`; `locked` while the second approval is on, `needsApprover` when another member must also admit a new device of the caller |
| `PUT` | `/api/tenants/:id/device-approval/mine` | *the member* | Body `{on}`. Session only, step-up. Turning it off: 409 `approval_locked` with the second approval, 403 in lockdown |
| `POST` | `/api/tenants/:id/members/:userId/devices/invalidate` | the member, or `manage_devices` | Remove every device of the member and revoke every key. The member stays |
| `DELETE` | `/api/tenants/:id/devices/:nodeId` | `manage_devices` or device owner | Remove device |
| `GET` | `/api/tenants/:id/auth-keys` | *any member* | List auth keys. `manage_devices` sees all keys, others see their own keys |
| `DELETE` | `/api/tenants/:id/auth-keys/:keyId` | `manage_devices` or key owner | Revoke auth key |
| `GET` | `/api/tenants/:id/device-approvals` | `approve_devices` | Headscale mode: list pending requests for a key |
| `GET` | `/api/tenants/:id/device-approvals/mine` | *any member* | Your own approval requests |
| `POST` | `/api/tenants/:id/device-approvals/:approvalId/approve` | `approve_devices` | Approve and generate the key |
| `POST` | `/api/tenants/:id/device-approvals/:approvalId/reject` | `approve_devices` | Reject |
| `POST` | `/api/tenants/:id/device-locks` | `lock_devices` | Lock a member to its current devices |
| `DELETE` | `/api/tenants/:id/device-locks` | `lock_devices` | Unlock a member |
| `GET` | `/api/tenants/:id/device-locks/:userId` | `lock_devices` or self | Lock status of a member |

### Notifications

| Method | Path | Permission | Description |
|--------|------|-----------|-------------|
| `GET` | `/api/tenants/:id/notifications` | *any member* | Your notifications in this tenant |
| `POST` | `/api/tenants/:id/notifications/read` | *any member* | Mark notifications as read |
| `POST` | `/api/tenants/:id/notifications/webhook/test` | `manage_settings` | Send a test event to the webhook |

The service creates a notification for each approval request (device, join, service) and for each limit hit. The recipients are the originator and the holders of the matching `approve_*` permission. The optional webhook is a tenant setting (`notificationWebhookUrl` and a secret). Each webhook request has an HMAC-SHA256 signature in the `X-Atproto-Tailnet-Signature` header.

### ACL and networking

| Method | Path | Permission | Description |
|--------|------|-----------|-------------|
| `GET` | `/api/tenants/:id/acl` | `manage_acl` | Get ACL policy |
| `PUT` | `/api/tenants/:id/acl` | `manage_acl` | Update ACL policy |
| `GET` | `/api/tenants/:id/routes` | `manage_devices` | List exit nodes and subnet routes |
| `POST` | `/api/tenants/:id/routes/:routeId/enable` | `manage_devices` | Approve route |
| `POST` | `/api/tenants/:id/routes/:routeId/disable` | `manage_devices` | Withdraw approval |
| `DELETE` | `/api/tenants/:id/routes/:routeId` | `manage_devices` | Withdraw approval |
| `GET` | `/api/tenants/:id/derp` | `manage_acl` | Get DERP config |
| `PUT` | `/api/tenants/:id/derp` | `manage_acl` | Update DERP config of this tenant |
| `GET` | `/api/tenants/:id/ip-config` | `manage_settings` | Get IP range config |
| `PUT` | `/api/tenants/:id/ip-config` | `manage_settings` | Update IP ranges |

### Federation

These endpoints return 404 unless `FEDERATION_ENABLED=true`. See [Federation](../guides/federation).

| Method | Path | Permission | Description |
|--------|------|-----------|-------------|
| `GET` | `/api/tenants/:id/federation` | `manage_settings` | List federation links |
| `POST` | `/api/tenants/:id/federation` | `manage_settings` | Create federation link request |
| `POST` | `/api/tenants/:id/federation/:linkId/accept` | `manage_settings` | Accept link |
| `POST` | `/api/tenants/:id/federation/:linkId/reject` | `manage_settings` | Reject link |
| `POST` | `/api/tenants/:id/federation/:linkId/revoke` | `manage_settings` | Revoke link |

### Roles, settings, security

| Method | Path | Permission | Description |
|--------|------|-----------|-------------|
| `GET` | `/api/tenants/:id/roles` | `manage_roles` | List roles |
| `POST` | `/api/tenants/:id/roles` | `manage_roles` | Create role |
| `PATCH` | `/api/tenants/:id/roles/:roleId` | `manage_roles` | Update role |
| `DELETE` | `/api/tenants/:id/roles/:roleId` | `manage_roles` | Delete role |
| `PATCH` | `/api/tenants/:id/default-role` | `manage_roles` | Set the default role for new members |
| `GET` | `/api/tenants/:id/settings` | *any member* | Get tenant settings |
| `PATCH` | `/api/tenants/:id/settings` | `manage_settings` | Update tenant settings |
| `GET` | `/api/tenants/:id/audit-log` | `view_audit_log` | Query audit log |

### Agent tokens

| Method | Path | Permission | Description |
|--------|------|-----------|-------------|
| `POST` | `/api/tenants/:id/agent-tokens` | `create_agent_tokens` | Create token |
| `GET` | `/api/tenants/:id/agent-tokens` | `manage_agent_tokens` | List tokens |
| `DELETE` | `/api/tenants/:id/agent-tokens/:tokenId` | `manage_agent_tokens` | Revoke token |

### Usage and limits

| Method | Path | Permission | Description |
|--------|------|-----------|-------------|
| `GET` | `/api/tenants/:id/usage` | *any member* | `{current, limits, overLimit, history}` (7-day history) |
| `PUT` | `/api/tenants/:id/limits` | *originator* | Set `maxDevices` and `maxMembers` (0 = unlimited). Not for agent tokens. Also `waitingDeviceHours` (1 to 8760, default 168): after this time a device that waits for admission is removed |

There are no plans. The originator sets the limits. A sub-collective cannot have higher limits than its parent. The service enforces the limits:

- Devices: at key issue and at device approval (403 `device_limit`).
- Members: at invitation accept and at join approval (403 `member_limit`).

### Operator API

Only instance operators (`OPERATOR_DIDS`) can use these endpoints. A session or an MCP token with the operator scope is necessary. Agent tokens never work here. Other callers get 403. An MCP token without the operator scope gets 403 `operator_scope_required`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/operator/overview` | All tailnets and users |
| `GET` | `/api/operator/settings` | Instance settings (`singleTailnet`, `defaultTailnetId`) |
| `PUT` | `/api/operator/settings` | Update instance settings. A new default tailnet starts to accept join requests. 409 `single_tailnet` if more than one top-level tailnet exists |
| `GET` | `/api/operator/tailnet-creators` | List tailnet creators |
| `POST` | `/api/operator/tailnet-creators` | Add a tailnet creator (handle or DID) |
| `DELETE` | `/api/operator/tailnet-creators/:id` | Remove a tailnet creator |
| `POST` | `/api/operator/tenants/:id/suspend` | Suspend a tailnet and its sub-tailnets. 502 `cascade_incomplete` if the control plane did not accept all changes |
| `POST` | `/api/operator/tenants/:id/unsuspend` | Unsuspend a tailnet and the sub-tailnets that the suspension included |
| `DELETE` | `/api/operator/tenants/:id` | Delete a tailnet |
| `POST` | `/api/operator/users/:id/disable` | Disable a user. Removes the memberships, devices and keys of the user, and revokes the MCP connections |
| `POST` | `/api/operator/users/:id/enable` | Enable a user |
| `GET` | `/api/operator/audit` | Instance activity log |

### MCP connections

Dashboard session only. Agent tokens and MCP tokens cannot use these endpoints.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/mcp/connections` | Your MCP connections: `[{id, clientName, operator, createdAt, lastUsedAt}]` |
| `DELETE` | `/api/mcp/connections/:id` | Revoke a connection and all its tokens |

### MCP server and OAuth

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/mcp` | MCP Streamable HTTP endpoint (stateless, JSON responses). Needs an MCP access token. `GET` and `DELETE` return 405 |
| `GET` | `/.well-known/oauth-protected-resource/mcp` | Protected resource metadata (RFC 9728) |
| `GET` | `/.well-known/oauth-authorization-server` | Authorization server metadata (RFC 8414) |
| `POST` | `/oauth/register` | Dynamic client registration (RFC 7591). Body limit 8 KiB |
| `GET`, `POST` | `/oauth/authorize` | Start authorization (PKCE S256). Goes to Bluesky sign-in, then to the consent page |
| `POST` | `/oauth/consent` | Allow or deny (session and CSRF token) |
| `POST` | `/oauth/token` | `authorization_code` and `refresh_token` grants |
| `POST` | `/oauth/revoke` | Token revocation (RFC 7009) |

---

## Coordinator admin API

Base URL: the listen address of the coordinator (default `http://127.0.0.1:9443`).

Authentication: `Authorization: Bearer <COORD_ADMIN_KEY>` on all `/api/*` endpoints. If `COORD_ADMIN_KEY` is not set, the admin API is disabled and returns 503. The `/health`, `/key` and `/ts2021` endpoints are public.

Only the TypeScript service uses the admin API. In the Docker stack, port 9443 is not published. Caddy sends only `/key`, `/ts2021` and `/health` on tenant subdomains to the coordinator.

### Public endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Returns `{"status": "ok"}` |
| `GET` | `/key` | Returns `{"publicKey": "mkey:...", "legacyPublicKey": "mkey:..."}` |

### Tailscale client protocol

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/ts2021` | Noise IK handshake upgrade |
| `POST` | `/machine/register` | Node registration (inside Noise session) |
| `POST` | `/machine/map` | Streaming map subscription (inside Noise session) |

### Tenants

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/tenants` | List all tenants |
| `POST` | `/api/tenants` | Create tenant. Body: `{"slug": "...", "parent_id": "...", "federation_posture": "..."}` |
| `GET` | `/api/tenants/:id` | Get tenant with children |
| `DELETE` | `/api/tenants/:id` | Delete tenant (fails with 409 if the tenant has children) |
| `GET` | `/api/tenants/:id/routes` | Get routes with aggregated child routes |
| `GET` | `/api/tenants/:id/nodes` | List nodes of the tenant |
| `DELETE` | `/api/tenants/:id/nodes` | Delete the nodes of one owner (`?owner=<user id>`). The service uses it when it removes a member |
| `POST` | `/api/tenants/:id/nodes/:node_id/routes` | Set the approved routes of a node |
| `GET` | `/api/tenants/:id/preauth-keys` | List pre-auth keys of the tenant |
| `DELETE` | `/api/tenants/:id/preauth-keys` | Revoke the keys of one owner (`?owner=<user id>`) |
| `DELETE` | `/api/tenants/:id/preauth-keys/:key_id` | Revoke one key |
| `GET` | `/api/tenants/:id/auto-approvers` | Get route auto-approvers |
| `PUT` | `/api/tenants/:id/auto-approvers` | Set route auto-approvers (tag based) |
| `GET` | `/api/tenants/:id/derp` | Get the DERP map of this tenant |
| `PUT` | `/api/tenants/:id/derp` | Set the DERP regions of this tenant. Body: `{"regions": {"900": {...}}, "include_default": true}` |
| `PUT` | `/api/tenants/:id/suspended` | Suspend or unsuspend. Body: `{"suspended": true}`. Nodes of a suspended tenant cannot register or poll the map |
| `GET` | `/api/tenants/:id/acl` | Get ACL policy |
| `POST` | `/api/tenants/:id/acl` | Set ACL policy |
| `PUT` | `/api/tenants/:id/posture` | Set federation posture. Body: `{"posture": "closed|selective|open"}` |

There is no global DERP endpoint. Each DERP change applies to one tenant.

The coordinator keeps DERP maps and auto-approvers in memory. The TypeScript service stores them in its database. It sends them again when the coordinator restarts (a new `boot_id`).

### Nodes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/nodes` | List all nodes (optional `?tenant_id=` filter) |
| `GET` | `/api/nodes/:id` | Get node details |
| `DELETE` | `/api/nodes/:id` | Delete node (optional `?tenant_id=` guard) |
| `POST` | `/api/nodes/:id/name` | Rename node. Body: `{"name": "..."}` |

### Pre-auth keys

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/preauth-keys` | Create key. Body: `{"tenant_id": "..."}` (required). Optional fields: `reusable`, `ephemeral`, `expiration_seconds`, `owner`, `tags`. The node inherits the owner and the tags |

### ACL (legacy endpoint)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/acl` | Set ACL for a tenant. Body: `{"tenant_id": "...", "policy": {...}}` |

### Federation messages

These endpoints exist only when `COORD_FEDERATION_ENABLED=true`. They are off by default. The TypeScript service is the authoritative federation endpoint.

All federation endpoints need a `CFP-Recipient` header. The header contains the DID of the target collective.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/federation/messages/hello` | Federation hello |
| `POST` | `/api/federation/messages/commit` | Federation commit |
| `POST` | `/api/federation/messages/keepalive` | Federation keepalive |
| `POST` | `/api/federation/messages/revoke` | Federation revoke |
| `POST` | `/api/federation/messages/link-request` | Link request |
| `POST` | `/api/federation/messages/link-accept` | Link accept |
| `POST` | `/api/federation/messages/link-reject` | Link reject |
| `POST` | `/api/federation/messages/link-revoke` | Link revoke |

### Error responses

All endpoints return JSON errors:

```json
{"error": "description of what went wrong"}
```

| Status | Meaning |
|--------|---------|
| 400 | Bad request (validation failure, invalid UUID, bad posture value) |
| 401 | Missing or invalid authentication |
| 403 | Node does not belong to the specified tenant |
| 404 | Resource not found |
| 405 | Method not allowed |
| 409 | Conflict (duplicate slug, tenant has children) |
| 413 | Request body too large (limit: 2 MiB) |
| 422 | Unprocessable entity (valid JSON but wrong shape) |
| 429 | Rate limited |
| 500 | Internal server error |
| 503 | Admin API disabled (`COORD_ADMIN_KEY` not set) or federation not configured |
