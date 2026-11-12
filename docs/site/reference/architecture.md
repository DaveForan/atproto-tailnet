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
              │  PostgreSQL  │
              │  (port 5432) │
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
| `coord-store` | Storage backends: `MemoryStore` (development) + `PgStore` (production) with `broadcast::Sender<PeerEvent>` |
| `coord-netmap` | Network map computation from store state |
| `coord-federation` | Federation protocol: session lifecycle, route engine, abuse controls, scoping, handshake state machine, auth, transport, discovery, inbound handlers |
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

### PostgreSQL

Shared database for both the TypeScript service and the coordinator. The service uses Drizzle ORM with 22 tables. The coordinator uses sqlx with its own `coord_*` prefixed tables. Both run their own migrations at startup.

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

## Architecture Decision Records

The project's design decisions are documented in 24 ADRs under `docs/adr/`:

| ADR | Title | Status |
|-----|-------|--------|
| 0001 | Use Headscale as the Tailscale control plane | Implemented |
| 0002 | Multi-tenancy via orchestrated Headscale instances | Implemented |
| 0003 | AT Protocol OAuth for user authentication | Implemented |
| 0004 | Service architecture and technology choices | Implemented |
| 0005 | Tenant security management | Implemented |
| 0006 | Custom DERP relay and IP range configuration | Implemented |
| 0007 | Usage metering, plan limits, and federation | Implemented |
| 0008 | Exit node and subnet router management | Implemented |
| 0009 | Hierarchical tenancy model | Implemented |
| 0010 | Federation control plane | Implemented |
| 0011 | Traversal policy engine | Implemented |
| 0012 | AT Proto identity as network passport | Implemented |
| 0013 | Multi-tenant Headscale fork | Superseded by 0023 |
| 0014 | Federation protocol specification (CFP) | Implemented |
| 0015 | Global / regional / local federation scoping | Implemented |
| 0016 | Federation transport and broker integration | Implemented |
| 0017 | DID resolution and identity verification | Implemented |
| 0018 | Dashboard completeness and correctness | Implemented |
| 0019 | Cross-instance federation links | Implemented |
| 0020 | Federation relay data plane | Implemented |
| 0021 | Holder binding for AT Proto accounts | Implemented |
| 0022 | Tenant TLS for any DNS provider | Proposed |
| 0023 | Rust mesh coordinator | In progress |
| 0024 | Purpose-built mesh client | Proposed |

## Database schema

### TypeScript service tables (22)

`users`, `tenants`, `roles`, `memberships`, `oauth_states`, `oauth_sessions`, `invitations`, `device_approvals`, `device_locks`, `join_requests`, `service_devices`, `services`, `board_posts`, `agent_tokens`, `audit_logs`, `usage_snapshots`, `federation_links`, `collective_dids`, `broker_sessions`, `relay_nodes`, `credential_revocations`, `holder_binding_challenges`, `service_auth_jti_cache`

### Coordinator tables

`coord_tenants`, `coord_nodes`, `coord_preauth_keys`, `coord_acl_policies`, `coord_federation_sessions`, `coord_federation_links`

Both schemas coexist in the same PostgreSQL database and are prefixed to avoid collisions.
