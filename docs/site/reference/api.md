---
title: API Reference
---

# API Reference

The platform exposes two API surfaces: the **TypeScript service API** (user-facing, session/token authenticated) and the **coordinator admin API** (internal, bearer token authenticated).

## TypeScript service API

Base URL: `https://yourdomain.com`

Authentication: Session cookie (browser) or `Authorization: Bearer at_XXXXX` (agent token).

Rate limits: 10 req/min on auth routes, 60 req/min on API routes.

### Public endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Service health check |
| `GET` | `/.well-known/atproto-client-metadata.json` | AT Proto OAuth client metadata |
| `GET` | `/.well-known/jwks.json` | Public JWKS for OAuth |
| `GET` | `/collective/:slug/did.json` | Collective DID document |
| `GET` | `/join/:slug` | Public join request page |
| `GET` | `/board/:slug` | Public service board |

### Authentication

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/auth/login?handle=<handle>` | Initiate AT Proto OAuth |
| `GET` | `/auth/callback` | OAuth callback |
| `GET` | `/auth/logout` | End session |

### User and tenant

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/me` | Current user info |
| `GET` | `/api/permissions` | Current user's permissions in context |
| `GET` | `/api/tenants` | List user's tenants |
| `GET` | `/api/tenants/:id` | Tenant details |
| `DELETE` | `/api/tenants/:id` | Delete tenant |
| `POST` | `/api/tenants/:id/start` | Start tenant instance |
| `POST` | `/api/tenants/:id/stop` | Stop tenant instance |
| `GET` | `/api/tenants/:id/health` | Live health probe |

### Members and invitations

| Method | Path | Permission | Description |
|--------|------|-----------|-------------|
| `GET` | `/api/tenants/:id/members` | *any member* | List members |
| `DELETE` | `/api/tenants/:id/members/:mid` | `kick` | Remove member |
| `PUT` | `/api/tenants/:id/members/:mid/role` | `manage_roles` | Change member's role |
| `POST` | `/api/tenants/:id/invitations` | `invite` | Create invitation |
| `GET` | `/api/tenants/:id/invitations` | `invite` | List invitations |
| `POST` | `/api/tenants/:id/invitations/:iid/accept` | *invitee* | Accept invitation |
| `POST` | `/api/tenants/:id/invitations/:iid/revoke` | `invite` | Revoke invitation |

### Devices and auth keys

| Method | Path | Permission | Description |
|--------|------|-----------|-------------|
| `GET` | `/api/tenants/:id/nodes` | *any member* | List connected devices |
| `POST` | `/api/tenants/:id/auth-key` | *any member* | Generate pre-auth key |
| `DELETE` | `/api/tenants/:id/nodes/:nid` | `manage_devices` | Remove device |
| `POST` | `/api/tenants/:id/nodes/:nid/rename` | `manage_devices` | Rename device |

### ACL and networking

| Method | Path | Permission | Description |
|--------|------|-----------|-------------|
| `GET` | `/api/tenants/:id/acl` | `manage_acl` | Get ACL policy |
| `PUT` | `/api/tenants/:id/acl` | `manage_acl` | Update ACL policy |
| `GET` | `/api/tenants/:id/routes` | `manage_devices` | List exit nodes and subnet routes |
| `POST` | `/api/tenants/:id/routes/:rid/enable` | `manage_devices` | Enable route |
| `POST` | `/api/tenants/:id/routes/:rid/disable` | `manage_devices` | Disable route |
| `DELETE` | `/api/tenants/:id/routes/:rid` | `manage_devices` | Delete route |
| `GET` | `/api/tenants/:id/derp` | `manage_acl` | Get DERP config |
| `PUT` | `/api/tenants/:id/derp` | `manage_acl` | Update DERP config |
| `GET` | `/api/tenants/:id/ip-config` | `manage_settings` | Get IP range config |
| `PUT` | `/api/tenants/:id/ip-config` | `manage_settings` | Update IP ranges |

### Federation

| Method | Path | Permission | Description |
|--------|------|-----------|-------------|
| `GET` | `/api/tenants/:id/federation` | `manage_settings` | List federation links |
| `POST` | `/api/tenants/:id/federation` | `manage_settings` | Create federation link request |
| `POST` | `/api/tenants/:id/federation/:lid/accept` | `manage_settings` | Accept link |
| `POST` | `/api/tenants/:id/federation/:lid/reject` | `manage_settings` | Reject link |
| `POST` | `/api/tenants/:id/federation/:lid/revoke` | `manage_settings` | Revoke link |

### Roles, settings, security

| Method | Path | Permission | Description |
|--------|------|-----------|-------------|
| `GET` | `/api/tenants/:id/roles` | `manage_roles` | List roles |
| `POST` | `/api/tenants/:id/roles` | `manage_roles` | Create role |
| `PUT` | `/api/tenants/:id/roles/:rid` | `manage_roles` | Update role |
| `DELETE` | `/api/tenants/:id/roles/:rid` | `manage_roles` | Delete role |
| `PUT` | `/api/tenants/:id/settings` | `manage_settings` | Update tenant settings |
| `GET` | `/api/tenants/:id/audit` | `view_audit_log` | Query audit log |

### Agent tokens

| Method | Path | Permission | Description |
|--------|------|-----------|-------------|
| `POST` | `/api/tenants/:id/agent-tokens` | `create_agent_tokens` | Create token |
| `GET` | `/api/tenants/:id/agent-tokens` | `manage_agent_tokens` | List tokens |
| `DELETE` | `/api/tenants/:id/agent-tokens/:tid` | `manage_agent_tokens` | Revoke token |

### Usage

| Method | Path | Permission | Description |
|--------|------|-----------|-------------|
| `GET` | `/api/tenants/:id/usage` | *any member* | Live counts + 7-day history |
| `PUT` | `/api/tenants/:id/plan` | *originator* | Set plan limits |

---

## Coordinator admin API

Base URL: the coordinator's listen address (default `http://127.0.0.1:9443`).

Authentication: `Authorization: Bearer <COORD_ADMIN_KEY>` on all `/api/*` endpoints. The `/health` and `/key` endpoints are public.

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
| `DELETE` | `/api/tenants/:id` | Delete tenant (fails if has children: 409) |
| `GET` | `/api/tenants/:id/routes` | Get routes with aggregated child routes |
| `GET` | `/api/tenants/:id/nodes` | List tenant's nodes |
| `GET` | `/api/tenants/:id/acl` | Get ACL policy |
| `POST` | `/api/tenants/:id/acl` | Set ACL policy |
| `PUT` | `/api/tenants/:id/posture` | Set federation posture. Body: `{"posture": "closed|selective|open"}` |

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
| `POST` | `/api/preauth-keys` | Create key. Body: `{"tenant_id": "..."}` (required) |

### ACL (legacy endpoint)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/acl` | Set ACL for a tenant. Body: `{"tenant_id": "...", "policy": {...}}` |

### Federation messages

All federation endpoints require a `CFP-Recipient` header with the target collective's DID.

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
| 403 | Node doesn't belong to specified tenant |
| 404 | Resource not found |
| 405 | Method not allowed |
| 409 | Conflict (duplicate slug, tenant has children) |
| 413 | Request body too large (limit: 2 MiB) |
| 422 | Unprocessable entity (valid JSON but wrong shape) |
| 429 | Rate limited |
| 500 | Internal server error |
| 503 | Federation not configured |
