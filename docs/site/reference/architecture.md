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

The application server uses Express 5 with Drizzle ORM. It does these tasks:

- **Web UI**: A React 19 SPA with 20 lazy-loaded tabs. esbuild builds it. The server serves it as external JS bundles from `public/js/`.
- **Authentication**: AT Protocol OAuth through `@atproto/oauth-client-node`.
- **API**: REST endpoints for all management operations.
- **Orchestration**: Tenant lifecycle, health monitoring, and Caddy route management.
- **Federation broker**: Session management, handshake state machines, and route installation. The broker is the application-layer complement to the protocol-level federation of the coordinator.

The service communicates with the coordinator through the admin REST API. The `getControlClient(tenant)` factory returns a `CoordinatorApiClient` or a `HeadscaleApiClient`. The choice depends on whether `COORDINATOR_URL` is set.

### Rust coordinator

The coordinator is a purpose-built, multi-tenant WireGuard control plane. The workspace has 8 crates:

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

The streaming map connection uses HTTP/2 with PING-based keepalive (30s interval, 90s timeout). The coordinator uses this keepalive to detect disconnects.

### Database

The TypeScript service needs PostgreSQL (Drizzle ORM, 22 tables). The coordinator supports three storage backends. You select the backend with `store_backend` in the TOML config or with the `COORD_STORE_BACKEND` env var:

- **PostgreSQL** (`postgres`): Shares the database of the TS service. The coord-store and the federation store both use sqlx with tables that have the prefix `coord_`.
- **SQLite** (`sqlite`): A single-file database with no dependencies. The coord-store and the federation store both persist to the same `.db` file (WAL mode). It is ideal for standalone coordinator deployments without the TS service.
- **Memory** (`memory`): All state stays in the process. The state is lost on restart. Use it only for development and testing.

The PostgreSQL and SQLite backends both run their own migrations at startup.

### Caddy

Caddy is a reverse proxy with dynamic subdomain routing. The TypeScript service manages one Caddy route (`@id: tailnet_tenants`) through the admin API. The service rewrites the route each time it adds or removes a tenant. Caddy does these tasks:

- TLS termination with a pluggable strategy (on-demand per-tenant certs, DNS-01 wildcard, or bring-your-own). See `caddy/tls-strategies/` and the [configuration reference](../reference/configuration.md#tls-strategies).
- Wildcard subdomain routing (`*.ts.yourdomain.com`).
- HTTP/2 and HTTP/3 (QUIC).

## Multi-tenancy

The mesh network of each user is an isolated tenant. In coordinator mode:

- Tenants are rows in `coord_tenants` with a UUID, a slug, a parent reference, and a federation posture.
- Nodes belong to a tenant through `tenant_id`.
- Pre-auth keys belong to a tenant.
- ACL policies apply to one tenant each.
- The streaming map delivers peer updates only for the same tenant (and for visible child tenants).
- IP allocation uses the CGNAT range (`100.64.0.0/10`). The coordinator assigns addresses in sequence for each tenant.

### Sub-collective hierarchy

Tenants can form a two-level parent/child hierarchy:

```
Organization (parent)
  ├── Team Alpha (child, posture: selective)
  ├── Team Beta (child, posture: closed)
  └── Team Gamma (child, posture: open)
```

- A parent sees the aggregated routes from children that are not closed.
- Nodes in a parent tenant receive peer information for nodes in visible child tenants.
- Children cannot have children (two levels maximum).
- Each child controls its federation posture independently.

## Security model

### Authentication layers

1. **AT Protocol OAuth**: Users authenticate through their PDS. The system stores no passwords. Session cookies with `sameSite: lax` protect against CSRF.

2. **Role-based access**: 16 granular permissions. You can combine them into custom roles. The originator identity is a hard flag. Nobody can downgrade it.

3. **Agent tokens**: Bearer tokens with the prefix `at_` for API access. The system stores them as SHA-256 hashes. Each token applies to one tenant and a subset of permissions. Expiry is mandatory.

4. **Coordinator admin auth**: A constant-time bearer token comparison on all `/api/*` endpoints.

### Network security

- **WireGuard encryption**: The system encrypts all device-to-device traffic at the transport layer.
- **Noise IK handshake**: The control plane connection is encrypted and has forward secrecy.
- **ACL enforcement**: The control plane applies firewall rules for each tenant.
- **SSRF defense**: DID resolution and outbound federation requests reject private IP addresses.
- **Body limits**: 2 MiB on all coordinator endpoints.
- **Rate limiting**: The TypeScript service applies rate limits to each route.

### Data protection

- The system encrypts collective signing keys at rest (AES-256-GCM).
- The system stores agent tokens as SHA-256 hashes (one-way).
- Session data is in PostgreSQL (not on the client).
- The dashboard HTML-escapes all data that users control.

## Database schema

### TypeScript service tables (22)

`users`, `tenants`, `roles`, `memberships`, `oauth_states`, `oauth_sessions`, `invitations`, `device_approvals`, `device_locks`, `join_requests`, `service_devices`, `services`, `board_posts`, `agent_tokens`, `audit_logs`, `usage_snapshots`, `federation_links`, `collective_dids`, `broker_sessions`, `relay_nodes`, `credential_revocations`, `holder_binding_challenges`, `service_auth_jti_cache`

### Coordinator tables

`coord_tenants`, `coord_nodes`, `coord_preauth_keys`, `coord_ipv4_counter` (SQLite only), `coord_federation_links`, `coord_broker_sessions`, `coord_collective_dids`

When you use PostgreSQL, the TS service schema and the coordinator schema exist in the same database. A prefix prevents name collisions. When you use SQLite, the coordinator manages its own `.db` file independently.
