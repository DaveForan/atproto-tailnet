# ADR-0013: Multi-tenant Headscale fork

**Status:** Superseded
**Date:** 2026-11-02
**Priority:** P1
**Depends On:** ADR-0001 (control plane choice), ADR-0009 (hierarchical tenancy)
**Superseded By:** ADR-0023 (Rust mesh coordinator)

## Context

ADR-0002 chose container-per-tenant orchestration over a Headscale fork. That
decision was correct at the time. The differentiator was the AT Proto identity
layer, fork maintenance was risky, and the escape hatch was documented: "fork
when we hit hundreds of tenants".

ADR-0009 does not yet trigger that threshold. We propose this ADR **ahead** of
the threshold to reduce the risk of the hierarchical tenancy work. We must
phase the fork. First, implement shared-instance safety (row-level security,
tenant_id scoping). Deploy the fork only when container-per-tenant reaches its
limits. This is preparation, not premature optimization.

Hierarchical tenancy introduces sub-collectives. A single root collective can
have hundreds or thousands of nested network units. Container-per-tenant fails
at this scale:

- **Resource overhead**: Each container uses 30-50MB RSS. The Headscale process
  uses approximately 30MB (ADR-0002). The Docker runtime, the overlay
  filesystem, and the sidecar processes add 10-20MB. A root collective with 200
  sub-collectives costs 6-10GB of control plane memory. Dozens of root
  collectives make the numbers untenable.
- **Port allocation**: The port pool (10001-10100) limits the system to 100
  simultaneous tenants. A larger range causes reverse proxy routing complexity
  and ephemeral port conflicts.
- **Docker socket dependency**: The socket gives root-equivalent privileges on
  the host. It complicates deployment on managed platforms (ECS, Cloud Run)
  because these platforms restrict or remove nested containers.
- **Startup latency**: Each container needs 2-5 seconds to start. A
  sub-collective tree (for example, a university with 50 departments) needs
  minutes of provisioning.
- **Orchestration burden**: The monitor loop probes each running tenant every
  60 seconds. At 500+ tenants, the sweep itself becomes a bottleneck.

ADR-0009 offers a "shared instance" mode. In this mode, each sub-collective
gets a Headscale namespace inside the parent's container. This is a
half-measure. Headscale's namespace isolation was not designed for multi-tenant
security. Two tenancy strategies also double the operational complexity.

## Decision

We forked Headscale and added first-class multi-tenant namespace separation
inside a single process. We run one shared instance instead of one container
per tenant.

### Why fork, not rewrite

Headscale represents years of Tailscale protocol compatibility. This includes
DERP relay coordination, node registration, key exchange, netmap distribution,
Noise IK handshakes, and continuing Tailscale client compatibility. The
analysis in ADR-0002 found approximately 40K lines of core code. A rewrite
means we re-implement all of this and always chase upstream protocol changes.

The Cylonix fork (documented in ADR-0002) proved that a fork is viable. It
added multi-dimensional namespace isolation with approximately 4K lines across
73 files. Our scope is narrower. We scope by tenant_id and do not build a full
4-tier auth model.

### Why Go stays

Go is the language of the Tailscale and WireGuard ecosystem. If we stay in Go,
we reuse Tailscale's own libraries directly (noise, key types, netmap
structs). We also get clean upstream rebases and no FFI boundary. Go is
memory-safe (GC, bounds-checked). The control plane is I/O-bound, so the
zero-cost abstractions of Rust give no material benefit. Rust also adds a
language boundary to every rebase.

### Multi-tenant changes

The fork adds tenant awareness as a thin layer across the Headscale
subsystems:

- **Namespace isolation**: Each collective gets a namespace. The namespace
  scopes node visibility, key distribution, and netmap generation. Nodes in
  different namespaces cannot discover or reach each other unless an operator
  routes them explicitly.
- **Shared database**: One PostgreSQL database holds all tenants. We added
  `tenant_id` to all tenant-scoped tables (`nodes`, `pre_auth_keys`,
  `api_keys`, `policies`, `routes`). The application isolates tenants with a
  mandatory `WHERE tenant_id = ?`. Composite indexes use
  `(tenant_id, <existing_pk>)`. PostgreSQL row-level security (RLS) adds
  defense-in-depth. The RLS policies use `current_setting('app.tenant_id')`.
  The application sets this value on each connection before it runs queries.
  If application code omits a WHERE clause, RLS still blocks cross-tenant data
  access at the database layer.
- **Per-namespace ACLs, DERP, and DNS**: Each namespace has its own ACL policy,
  its own DERP relay regions (ADR-0006), and its own MagicDNS config. The
  system evaluates each one independently. The existing ACL engine already
  takes user and node lists as parameters. The change scopes those lists by
  tenant.
- **Shared DERP relays**: The relay servers stay shared. WireGuard encryption
  isolates the data plane. Sharing spreads the relay cost across all tenants.
- **API changes**: All endpoints gain `X-Tenant-ID` context (header or path
  prefix). Only the application middleware sets `X-Tenant-ID`. It takes the
  value from the authenticated session or token and **never** from external
  request headers. The ingress layer must strip any client-supplied
  `X-Tenant-ID` header before the request reaches the application. The
  atproto-tailnet service translates its collective context into the correct
  tenant header when it calls Headscale.

### Migration path

1. **Fork and extend schema**: Add `tenant_id` to all tenant-scoped tables.
   Modify the queries for tenant scoping. Run the full upstream test suite to
   confirm that no single-tenant regressions exist.
2. **Tenant-aware API**: Modify the gRPC/REST API to accept tenant context and
   propagate it through middleware.
3. **Deploy shared instance**: Replace the container-per-tenant orchestrator
   with a single shared process. Migrate existing tenant data into the shared
   database with the correct `tenant_id` values (see the migration subsection
   below).
4. **Retain container fallback**: Keep container-per-tenant as a legacy path
   for isolation-sensitive deployments. A per-collective `isolationMode` flag
   (`shared` | `dedicated`) selects the path. This matches ADR-0009.
5. **Extend for hierarchy**: Add parent namespace visibility, cross-namespace
   routing, and cascading policy inheritance (ADR-0009).

### SQLite-to-PostgreSQL migration

Step 3 above is not simple. Each existing container-per-tenant instance uses
its own SQLite database. The migration tool must:

- Iterate each tenant's SQLite database file
- Extract nodes, pre-auth keys, API keys, routes, and ACL policies
- Transform the records to the shared PostgreSQL schema with the correct
  `tenant_id`
- Insert the records into PostgreSQL and preserve the existing WireGuard keys
  and node registrations, so that running devices do not need to register
  again
- Validate the row counts and the key material integrity after migration

The existing WireGuard keys and node registrations are the critical invariant.
The `machineKey` and `nodeKey` of a device must stay unchanged through the
migration for a zero-downtime cutover. The migration must run three passes.
The first pass is read-only (a dry run with diff output). The second pass
writes. The third pass verifies and compares source and destination row by
row.

### Upstream relationship

We maintain the fork as a thin diff over upstream:

- Isolate multi-tenant changes in a `tenant` package where possible
- Make database migrations additive (new columns, not altered columns)
- Contribute non-multi-tenant improvements back upstream
- Track upstream releases within one release cycle (Headscale releases
  approximately monthly). Weekly tracking is for **monitoring** new releases,
  not for merging. The actual rebase targets each upstream release. CI runs
  the upstream test suite against the fork continuously

## Consequences

- **Resource reduction**: A single process uses approximately 100-200MB for any
  tenant count. Per-tenant containers use 30-50MB each. At 500 collectives, the
  numbers are 200MB against 15-25GB.
- **Eliminates Docker socket**: Deployment simplifies to a single binary plus
  PostgreSQL. Managed container platforms become viable.
- **Removes port allocation**: The system uses a single listening port. The
  application layer routes tenants with context headers.
- **Shared failure domain**: A crash affects all tenants. Mitigate this with
  health checks, graceful degradation, and the dedicated-instance fallback.
  Consider 2-3 instances behind a load balancer for availability.
- **Fork maintenance**: We must rebase against upstream releases. The Cylonix
  experience (approximately 4K lines of diff) suggests approximately one
  engineer-day for each release for rebase and validation.
- **Enables hierarchy**: Parent and child namespace visibility, cross-namespace
  routing, and cascading policy enforcement become in-process operations. They
  no longer need cross-container orchestration.
- **Federation broker transition (ADR-0010)**: We designed the federation
  broker as a container sidecar next to per-tenant Headscale instances. With a
  shared Headscale instance, the broker becomes a built-in module or a
  co-process inside the shared instance. It communicates with in-process calls
  instead of inter-container networking.
- **Legacy code path**: The container-per-tenant orchestrator
  (`orchestrator/headscale.ts`, `caddy.ts`, `ports.ts`) becomes secondary. We
  maintain it for dedicated-instance mode, but it will receive less attention.
- **Provisioning speed**: New collective creation drops from seconds (container
  start) to milliseconds (DB insert and namespace registration).

## Future considerations

- **Horizontal scaling**: Shard tenants across instances by tenant_id hash. The
  shared-database design supports this because the instances are stateless
  except for the in-memory node caches.
- **Namespace quotas**: Set per-namespace resource limits (maximum nodes,
  maximum keys). The limits prevent one namespace from monopolizing the
  resources of the shared process.
- **Observability**: Export per-tenant Prometheus metrics from the shared
  process. These replace the per-container health probe model.
