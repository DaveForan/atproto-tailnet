# ADR-0004: Service architecture and technology choices

**Status:** Accepted
**Date:** 2026-10-23

> Note (2026-11-26): the Headscale mode was removed (ADR-0040). The coordinator is the only control plane.

## Context

We need a service layer between AT Proto OAuth (identity) and the Headscale instances (networking). The service layer handles these functions:

- Tenant lifecycle
- User management
- Invitations
- Instance orchestration

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
| **PostgreSQL** | Service state: users, tenants, memberships, invitations, OAuth sessions. It does NOT store Headscale data. Each Headscale instance owns its own SQLite. |
| **Headscale instances** | One for each tenant. Docker containers (dev) or systemd units (prod) run the instances. Each instance has its own config, DB, API key, and port. |
| **Caddy** | TLS termination and subdomain routing. `<tenant>.ts.example.com` → correct Headscale port. `api.ts.example.com` → service API. Caddy obtains Let's Encrypt certificates automatically. |

### Technology choices

| Choice | Rationale |
|--------|-----------|
| **TypeScript / Node.js** | The AT Proto SDK is TypeScript-first. It is the primary stack of Dave. |
| **Express** | Simple and well-known. It has no framework magic. |
| **PostgreSQL** | Relational data (users, tenants, memberships). It is proven technology. |
| **Drizzle ORM** | Type-safe and lightweight. It has good migration support. |
| **Docker** for Headscale instances | Isolation and an easy lifecycle (create/start/stop/rm). We use it in dev and in the first production release. |
| **Caddy** | Automatic TLS with wildcard certificates. Clean reverse proxy config. An API for dynamic upstreams. |

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

Each Headscale instance exposes a gRPC API (and REST through grpc-gateway). The service communicates with each instance with these items:

- An API key for the instance (generated at provisioning time)
- A `localhost:<port>` connection (the service and instance run on the same host, so internal TLS is not necessary)

The service uses these key operations:

- **Create user**: when a user accepts an invitation
- **Create pre-auth key**: for node registration
- **List nodes**: for the dashboard
- **Delete node**: for device management
- **Set/update ACL policy**: for network rules

## Consequences

- Docker is the first instance manager. We can change to K8s, systemd, or Firecracker later. The service layer does not change.
- Port allocation needs a simple registry (a DB table) to prevent collisions.
- The Caddy admin API registers upstreams dynamically. It does not need a config reload.
- The service API is the single source of truth for tenant and user state. We treat Headscale instances as disposable infrastructure.
