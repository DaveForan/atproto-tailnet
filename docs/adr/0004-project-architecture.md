# ADR-0004: Service architecture and technology choices

**Status:** Accepted
**Date:** 2026-10-23

## Context

We need a service layer that sits between AT Proto OAuth (identity) and Headscale instances (networking). It handles tenant lifecycle, user management, invitations, and instance orchestration.

## Decision

### Architecture

```
                                   ┌──────────────────────────┐
                                   │     Reverse Proxy        │
                                   │  (Caddy — auto TLS,      │
                                   │   subdomain routing)      │
                                   └────────┬─────────────────┘
                                            │
                        ┌───────────────────┼───────────────────┐
                        │                   │                   │
                  ┌─────▼─────┐    ┌────────▼────────┐  ┌──────▼──────┐
                  │  Service  │    │   Headscale #1   │  │ Headscale #N│
                  │   API     │    │  (tenant: alice) │  │ (tenant: N) │
                  │ (Node.js) │    │  :10001          │  │ :100NN      │
                  │ :3000     │    │  SQLite           │  │ SQLite      │
                  └─────┬─────┘    └──────────────────┘  └─────────────┘
                        │
                  ┌─────▼─────┐
                  │ PostgreSQL│
                  │ (service  │
                  │  state)   │
                  └───────────┘
```

### Component responsibilities

| Component | Role |
|-----------|------|
| **Service API** | AT Proto OAuth, tenant CRUD, user/invitation management, Headscale instance orchestration, pre-auth key generation via Headscale gRPC API |
| **PostgreSQL** | Service state: users, tenants, memberships, invitations, OAuth sessions. NOT Headscale data — each Headscale instance owns its own SQLite. |
| **Headscale instances** | One per tenant. Managed as Docker containers (dev) or systemd units (prod). Each has its own config, DB, API key, and port. |
| **Caddy** | TLS termination, subdomain routing. `<tenant>.ts.example.com` → correct Headscale port. `api.ts.example.com` → service API. Automatic Let's Encrypt. |

### Technology choices

| Choice | Rationale |
|--------|-----------|
| **TypeScript / Node.js** | AT Proto SDK is TypeScript-first. Dave's primary stack. |
| **Express** | Simple, well-known. No framework magic. |
| **PostgreSQL** | Relational data (users, tenants, memberships). Proven. |
| **Drizzle ORM** | Type-safe, lightweight, good migration story. |
| **Docker** for Headscale instances | Isolation, easy lifecycle (create/start/stop/rm). Dev and initial prod. |
| **Caddy** | Automatic TLS with wildcard certs. Clean reverse proxy config. API for dynamic upstreams. |

### Headscale instance lifecycle

```
create_tenant(did, handle):
  1. Generate tenant slug from handle (e.g., "alice-bsky-social")
  2. Allocate port from pool
  3. Generate Headscale config from template (base_domain, port, API key)
  4. Create Docker container with mounted config + data volume
  5. Start container
  6. Register upstream in Caddy
  7. Store tenant record in PostgreSQL

delete_tenant(tenant_id):
  1. Stop and remove Docker container
  2. Remove Caddy upstream
  3. Optionally archive data volume
  4. Mark tenant as deleted in PostgreSQL
```

### Headscale API integration

Each Headscale instance exposes a gRPC API (and REST via grpc-gateway). The service communicates with each instance using:

- Instance-specific API key (generated at provisioning time)
- `localhost:<port>` connection (co-located, no TLS needed internally)

Key operations:
- **Create user** — when someone accepts an invitation
- **Create pre-auth key** — for node registration
- **List nodes** — for the dashboard
- **Delete node** — for device management
- **Set/update ACL policy** — for network rules

## Consequences

- Docker is the initial instance manager; can swap to K8s, systemd, or Firecracker later without changing the service layer.
- Port allocation needs a simple registry (DB table) to avoid collisions.
- Caddy's admin API allows dynamic upstream registration without config reload.
- The service API is the single source of truth for tenant/user state; Headscale instances are treated as disposable infrastructure.
