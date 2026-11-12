---
title: Architecture
---

# Architecture

## System overview

```
                     Internet
                        │
                ┌───────┴───────┐
                │     Caddy     │  TLS termination
                │  (ports 80,   │  Wildcard subdomains
                │   443)        │  Dynamic routing via admin API
                └───┬───────┬───┘
                    │       │
          ┌─────────┘       └──────────┐
          ▼                            ▼
  ┌───────────────┐          ┌─────────────────┐
  │  TypeScript   │          │  Rust           │
  │  Service      │          │  Coordinator    │
  │  (port 3000)  │◄────────►│  (port 9443)    │
  │               │  REST    │                 │
  │  Web UI       │  admin   │  Noise IK       │
  │  OAuth        │  API     │  Multi-tenant   │
  │  Orchestrator │          │  Federation     │
  └───────┬───────┘          └────────┬────────┘
          │                           │
          └──────────┬────────────────┘
                     ▼
              ┌──────────────┐
              │  PostgreSQL  │  (service layer + coordinator)
              │  (port 5432) │  or SQLite (coordinator standalone)
              └──────────────┘
```

## Components

### TypeScript service

The application server, built on Express 5 with Drizzle ORM. Handles:

- **Web UI**: Single-page dashboard served inline (no separate frontend build)
- **Authentication**: AT Protocol OAuth via `@atproto/oauth-client-node`
- **API**: REST endpoints for all management operations
- **Orchestration**: Tenant lifecycle, health monitoring, Caddy route management
- **Federation broker**: Session management, handshake state machines, route installation (application-layer complement to the coordinator's protocol-level federation)

The service communicates with the coordinator via the admin REST API. The `getControlClient(tenant)` factory returns either a `CoordinatorApiClient` or `HeadscaleApiClient` depending on whether `COORDINATOR_URL` is set.

### Rust coordinator

A purpose-built, multi-tenant WireGuard control plane. The workspace has 8 crates:

| Crate | Purpose |
|-------|---------|
| `coord-core` | Shared types: `TenantId`, `NodeId`, `ControlKey`, `MachineKey`, error types, federation types |
| `coord-noise` | Noise IK handshake (`snow` library) + encrypted transport with Tailscale-compatible big-endian nonces |
| `coord-proto` | Tailscale control protocol messages: `RegisterRequest`/`Response`, `MapRequest`/`Response` |
| `coord-acl` | ACL policy engine: per-tenant rules compiled to Tailscale `FilterRule` format |
| `coord-store` | Storage backends: `MemoryStore` (dev), `PgStore` (PostgreSQL), `SqliteStore` (SQLite) with `broadcast::Sender<PeerEvent>` |
| `coord-netmap` | Network map computation from store state |
| `coord-federation` | Federation protocol: session lifecycle, route engine, abuse controls, scoping, handshake state machine, auth, transport, discovery, inbound handlers. Storage: `PgFederationStore`, `SqliteFederationStore`, `FederationMemoryStore` |
| `coord-api` | axum HTTP server: admin REST API, Noise handshake endpoint, health, federation message endpoints |

#### Protocol flow

```
Tailscale client                    Coordinator
      │                                  │
      ├── POST /ts2021 ────────────────►│  Noise IK handshake
      │◄─────── Noise session ──────────┤  (25519/ChaChaPoly/BLAKE2s)
      │                                  │
      │   ══ HTTP/2 over Noise ══        │
      │                                  │
      ├── POST /machine/register ──────►│  Pre-auth key validation
      │◄─────── RegisterResponse ───────┤  IP allocation (CGNAT)
      │                                  │
      ├── POST /machine/map ───────────►│  Subscribe to peer updates
      │◄─────── MapResponse (stream) ───┤  zstd-framed deltas
      │◄─────── PeersChanged ──────────┤  Every 60s keepalive
      │◄─────── PeersRemoved ──────────┤  On disconnect
      │                                  │
```

The streaming map connection uses HTTP/2 with PING-based keepalive (30s interval, 90s timeout) for disconnect detection.

### Database

The TypeScript service requires PostgreSQL (Drizzle ORM, 22 tables). The coordinator supports three storage backends, selected explicitly via `store_backend` in the TOML config or `COORD_STORE_BACKEND` env var:

- **PostgreSQL** (`postgres`): Shares the same database as the TS service. Both coord-store and federation store use sqlx with `coord_*` prefixed tables.
- **SQLite** (`sqlite`): Zero-dependency single-file database. Both coord-store and federation store persist to the same `.db` file (WAL mode). Ideal for standalone coordinator deployments without the TS service.
- **Memory** (`memory`): All state in-process, lost on restart. For development and testing only.

Both PostgreSQL and SQLite backends run their own migrations at startup.

### Caddy

Reverse proxy with dynamic subdomain routing. The TypeScript service manages one Caddy route (`@id: tailnet_tenants`) via the admin API, rewriting it whenever tenants are added or removed. Caddy handles:

- TLS termination (Let's Encrypt or Cloudflare DNS-01)
- Wildcard subdomain routing (`*.ts.yourdomain.com`)
- HTTP/2 and HTTP/3 (QUIC)

## Multi-tenancy

Each user's mesh network is an isolated tenant. In coordinator mode:

- Tenants are rows in `coord_tenants` with a UUID, slug, parent reference, and federation posture
- Nodes are scoped to a tenant via `tenant_id`
- Pre-auth keys are scoped to a tenant
- ACL policies are per-tenant
- The streaming map only delivers peer updates for the same tenant (plus visible child tenants)
- IP allocation uses the CGNAT range (`100.64.0.0/10`), sequentially assigned per tenant

### Sub-collective hierarchy

Tenants can form a two-level parent/child hierarchy:

```
Organization (parent)
  ├── Team Alpha (child, posture: selective)
  ├── Team Beta (child, posture: closed)
  └── Team Gamma (child, posture: open)
```

- A parent sees aggregated routes from non-closed children
- Nodes in a parent tenant receive peer info for nodes in visible child tenants
- Children cannot themselves have children (two levels maximum)
- Each child independently controls its federation posture

## Security model

### Authentication layers

1. **AT Protocol OAuth**: Users authenticate via their PDS. No passwords stored. Session cookies with `sameSite: lax` for CSRF protection.

2. **Role-based access**: 16 granular permissions, composable into custom roles. The originator identity is a hard flag that cannot be downgraded.

3. **Agent tokens**: `at_`-prefixed Bearer tokens for API access. SHA-256 hashed, scoped to one tenant + permission subset, mandatory expiry.

4. **Coordinator admin auth**: Constant-time bearer token comparison on all `/api/*` endpoints.

### Network security

- **WireGuard encryption**: All device-to-device traffic is encrypted at the transport layer
- **Noise IK handshake**: The control plane connection itself is encrypted with forward secrecy
- **ACL enforcement**: Per-tenant firewall rules applied at the control plane level
- **SSRF defense**: DID resolution and federation outbound requests reject private IP addresses
- **Body limits**: 2 MiB on all coordinator endpoints
- **Rate limiting**: Per-route rate limits on the TypeScript service

### Data protection

- Collective signing keys encrypted at rest (AES-256-GCM)
- Agent tokens stored as SHA-256 hashes (one-way)
- Session data in PostgreSQL (not client-side)
- All user-controlled data HTML-escaped in the dashboard

## Database schema

### TypeScript service tables (22)

`users`, `tenants`, `roles`, `memberships`, `oauth_states`, `oauth_sessions`, `invitations`, `device_approvals`, `device_locks`, `join_requests`, `service_devices`, `services`, `board_posts`, `agent_tokens`, `audit_logs`, `usage_snapshots`, `federation_links`, `collective_dids`, `broker_sessions`, `relay_nodes`, `credential_revocations`, `holder_binding_challenges`, `service_auth_jti_cache`

### Coordinator tables

`coord_tenants`, `coord_nodes`, `coord_preauth_keys`, `coord_ipv4_counter` (SQLite only), `coord_federation_links`, `coord_broker_sessions`, `coord_collective_dids`

When using PostgreSQL, both the TS service and coordinator schemas coexist in the same database, prefixed to avoid collisions. When using SQLite, the coordinator manages its own `.db` file independently.
