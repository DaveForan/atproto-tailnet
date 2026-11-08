# ADR-0013: Multi-tenant Headscale fork

**Status:** Superseded
**Date:** 2026-11-02
**Priority:** P1
**Depends On:** ADR-0001 (control plane choice), ADR-0009 (hierarchical tenancy)
**Superseded By:** ADR-0023 (Rust mesh coordinator)

## Context

ADR-0002 chose container-per-tenant orchestration over forking Headscale. That
decision was correct at the time: the differentiator was the AT Proto identity
layer, fork maintenance was risky, and the escape hatch was documented ("fork
when we hit hundreds of tenants"). ADR-0009 does not yet trigger that threshold,
but this ADR is proposed **ahead** of it to de-risk the hierarchical tenancy
work. The fork should be phased: implement shared-instance safety (row-level
security, tenant_id scoping) first, deploy only when container-per-tenant
actually hits limits. This is preparation, not premature optimization.

Hierarchical tenancy introduces sub-collectives — potentially hundreds or
thousands of nested network units under a single root collective. Container-per-
tenant breaks down at this scale:

- **Resource overhead**: 30-50MB RSS per container (the Headscale process itself
  is ~30MB per ADR-0002; Docker runtime, overlay filesystem, and sidecar
  processes add 10-20MB). A root collective with 200 sub-collectives costs
  6-10GB in control plane memory alone. Multiply by dozens of root collectives
  and the numbers become untenable.
- **Port allocation**: The port pool (10001-10100) caps the system at 100
  simultaneous tenants. Expanding the range creates reverse proxy routing
  complexity and ephemeral port conflicts.
- **Docker socket dependency**: Root-equivalent privileges on the host.
  Complicates deployment on managed platforms (ECS, Cloud Run) where nested
  containers are restricted or unavailable.
- **Startup latency**: 2-5 seconds per container. Creating a sub-collective tree
  (e.g., a university with 50 departments) means minutes of provisioning.
- **Orchestration burden**: The monitor loop probes every running tenant every 60
  seconds. At 500+ tenants, the sweep itself becomes a bottleneck.

ADR-0009 offers a "shared instance" mode where sub-collectives get a Headscale
namespace within the parent's container. This is a half-measure: Headscale's
namespace isolation was not designed for multi-tenant security, and mixing two
tenancy strategies doubles operational complexity.

## Decision

Fork Headscale and add first-class multi-tenant namespace separation within a
single process. Run one shared instance instead of one container per tenant.

### Why fork, not rewrite

Headscale represents years of Tailscale protocol compatibility: DERP relay
coordination, node registration, key exchange, netmap distribution, Noise IK
handshakes, and ongoing Tailscale client compatibility. ADR-0002's analysis
found ~40K core LOC. A rewrite means re-implementing all of this and
perpetually chasing upstream protocol changes.

The Cylonix fork (documented in ADR-0002) proved viability: ~4K lines across 73
files added multi-dimensional namespace isolation. Our scope is narrower —
tenant_id scoping, not a full 4-tier auth model.

### Why Go stays

Go is the language of the entire Tailscale/WireGuard ecosystem. Staying in Go
means direct reuse of Tailscale's own libraries (noise, key types, netmap
structs), clean upstream rebases, and no FFI boundary. Go is memory-safe (GC,
bounds-checked). The control plane is I/O-bound — Rust's zero-cost abstractions
add no material benefit while imposing a language boundary on every rebase.

### Multi-tenant changes

The fork adds tenant awareness as a thin layer across Headscale's subsystems:

- **Namespace isolation**: Each collective gets a namespace scoping node
  visibility, key distribution, and netmap generation. No cross-namespace
  discovery or communication unless explicitly routed.
- **Shared database**: Single PostgreSQL with `tenant_id` added to all tenant-
  scoped tables (`nodes`, `pre_auth_keys`, `api_keys`, `policies`, `routes`).
  Application-level isolation via mandatory `WHERE tenant_id = ?`. Composite
  indexes on `(tenant_id, <existing_pk>)`. Defense-in-depth via PostgreSQL
  row-level security (RLS) policies keyed on `current_setting('app.tenant_id')`,
  set per-connection by the application before executing queries. RLS ensures
  that even if application code omits a WHERE clause, cross-tenant data access
  is blocked at the database layer.
- **Per-namespace ACLs, DERP, and DNS**: Each namespace carries its own ACL
  policy, DERP relay regions (ADR-0006), and MagicDNS config, evaluated
  independently. The existing ACL engine already parameterizes on user/node
  lists — the change is scoping those lists by tenant.
- **Shared DERP relays**: Relay servers remain shared. WireGuard encryption
  provides data-plane isolation. Amortizes relay cost across all tenants.
- **API changes**: All endpoints gain `X-Tenant-ID` context (header or path
  prefix). `X-Tenant-ID` is set exclusively by the application middleware from
  the authenticated session or token — **never** from external request headers.
  Any client-supplied `X-Tenant-ID` header must be stripped at the ingress
  layer before the request reaches the application. The atproto-tailnet service
  translates its collective context into the appropriate tenant header when
  calling Headscale.

### Migration path

1. **Fork and extend schema**: Add `tenant_id` to all tenant-scoped tables.
   Modify queries for tenant scoping. Run the full upstream test suite to
   confirm no single-tenant regressions.
2. **Tenant-aware API**: Modify gRPC/REST API to accept and propagate tenant
   context via middleware.
3. **Deploy shared instance**: Replace container-per-tenant orchestrator with a
   single shared process. Migrate existing tenant data into the shared database
   with appropriate `tenant_id` values (see migration subsection below).
4. **Retain container fallback**: Keep container-per-tenant as a legacy path for
   isolation-sensitive deployments. A per-collective `isolationMode` flag
   (`shared` | `dedicated`) controls which path is used, matching ADR-0009.
5. **Extend for hierarchy**: Add parent namespace visibility, cross-namespace
   routing, and cascading policy inheritance (ADR-0009).

### SQLite-to-PostgreSQL migration

Step 3 above is non-trivial. Each existing container-per-tenant instance uses its
own SQLite database. The migration tool must:

- Iterate each tenant's SQLite database file
- Extract nodes, pre-auth keys, API keys, routes, and ACL policies
- Transform records to the shared PostgreSQL schema with the correct `tenant_id`
- Insert into PostgreSQL, preserving existing WireGuard keys and node
  registrations so that running devices do not need to re-register
- Validate row counts and key material integrity post-migration

Existing WireGuard keys and node registrations are the critical invariant: a
device's `machineKey` and `nodeKey` must survive the migration unchanged for
zero-downtime cutover. The migration should run in a read-only pass first
(dry run with diff output), then a write pass, then a verification pass that
compares source and destination row-by-row.

### Upstream relationship

Maintain the fork as a thin diff over upstream:

- Multi-tenant changes isolated behind a `tenant` package where possible
- Database migrations are additive (new columns, not altered columns)
- Non-multi-tenant improvements contributed back upstream
- Track upstream releases within one release cycle (Headscale releases roughly
  monthly). Weekly tracking is for **monitoring** new releases, not merging —
  the actual rebase targets each upstream release. CI runs upstream's test suite
  against the fork continuously

## Consequences

- **Resource reduction**: Single process ~100-200MB regardless of tenant count,
  versus 30-50MB per tenant container. At 500 collectives: 200MB vs 15-25GB.
- **Eliminates Docker socket**: Deployment simplifies to a single binary plus
  PostgreSQL. Managed container platforms become viable.
- **Removes port allocation**: Single listening port; tenant routing at the
  application layer via context headers.
- **Shared failure domain**: A crash affects all tenants. Mitigate with health
  checks, graceful degradation, and the dedicated-instance fallback. Consider
  2-3 instances behind a load balancer for availability.
- **Fork maintenance**: Must rebase against upstream releases. The Cylonix
  experience (~4K lines diff) suggests ~1 engineer-day per release for rebase
  and validation.
- **Enables hierarchy**: Parent/child namespace visibility, cross-namespace
  routing, and cascading policy enforcement become in-process operations instead
  of cross-container orchestration.
- **Federation broker transition (ADR-0010)**: The federation broker was designed
  as a container sidecar alongside per-tenant Headscale instances. With a shared
  Headscale instance, the broker transitions to a built-in module or co-process
  within the shared instance, communicating via in-process calls rather than
  inter-container networking.
- **Legacy code path**: The container-per-tenant orchestrator
  (`orchestrator/headscale.ts`, `caddy.ts`, `ports.ts`) becomes secondary.
  Maintain for dedicated-instance mode but expect declining attention.
- **Provisioning speed**: New collective creation drops from seconds (container
  spin-up) to milliseconds (DB insert + namespace registration).

## Future considerations

- **Horizontal scaling**: Shard tenants across multiple instances by tenant_id
  hash. The shared-database design supports this — instances are stateless
  beyond in-memory node caches.
- **Namespace quotas**: Per-namespace resource limits (max nodes, max keys) to
  prevent monopolization of shared process resources.
- **Observability**: Per-tenant Prometheus metrics from the shared process,
  replacing the per-container health probe model.
