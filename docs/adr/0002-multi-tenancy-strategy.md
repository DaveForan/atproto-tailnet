# ADR-0002: Multi-tenancy via orchestrated Headscale instances

**Status:** Accepted
**Date:** 2026-10-23

> Note (2026-11-26): the Headscale mode was removed (ADR-0040). The coordinator is the only control plane.

## Context

Headscale is single-tenant by design: one instance runs one tailnet. The maintainers rejected multi-tenancy as out of scope (issue #2711). Our service needs multiple isolated tailnets.

### Options considered

| Option | Effort | Isolation | Maintenance burden |
|--------|--------|-----------|-------------------|
| **A: Fork Headscale, add tenant_id** | 4-8 weeks MVP, 5-7K LOC changes across ~70 files | Full (if done right) | High. We must rebase on every upstream release. Headscale changes fast (v0.29.1, active development). |
| **B: ACL-based isolation within single instance** | 1 week | Partial. ACLs block data-plane traffic, but DNS, DERP, IP pool, and node enumeration leak across tenants. | Low. No fork. |
| **C: One Headscale instance per tenant (orchestrator)** | 2-3 weeks for orchestrator | Perfect. Each tenant has separate processes, DBs, configs, and DNS domains. | Low. We use upstream unmodified. Operations cost grows linearly with the number of tenants. |

### Fork feasibility assessment (Option A)

We analyzed the Headscale codebase in depth (see `research_notes/`):

- **Cylonix fork** proves the fork is possible. It has ~4K lines across 73 files and 79 commits. It adds Namespace and NetworkDomain dimensions with 4-tier auth.
- **Subsystem difficulty**:
  - Database: Medium.
  - API v2: Easy-Medium. The URLs already have a `{tailnet}` parameter.
  - Policy: Medium. It already takes user and node lists as parameters.
  - DNS: Easy. It follows from netmap isolation.
  - DERP: Easy. A shared relay is acceptable.
  - State singleton: Hard. 115 methods assume global state.
  - Tests: Hard. 122K LOC assume a single tenant.
- **Risk**: The Cylonix fork targets an older Headscale. The current codebase changed much (NodeStore copy-on-write, change.Change system, credentials unification, v2 API). The real cost is fork maintenance, not the first implementation.

### Why we chose Option C

1. **Zero fork maintenance.** We use upstream Headscale as is. We track releases with little effort.
2. **Perfect isolation by default.** Cross-tenant data leaks are not possible. Each tenant has its own process, database, and DNS domain.
3. **The identity layer (AT Proto) is our differentiator.** The control plane internals are not. We spend engineering time on the identity layer.
4. **An escape hatch exists.** If we reach a scaling limit (hundreds of tenants, where per-tenant containers cost too much), we can fork then. Real usage patterns will guide us, not speculation.
5. **The operational cost is manageable.** Headscale is lightweight (single Go binary, SQLite). One host can run dozens of instances. We can move to containers or K8s later.

## Decision

We run **one Headscale instance for each tenant**. An orchestration service manages the instances. Each instance has:

- Its own SQLite database
- Its own DNS subdomain (`<tenant-slug>.atproto-tailnet.example.com`)
- Its own config file (generated from a template)
- Its own listening port (reverse-proxied through Caddy/Nginx)
- Access to the shared DERP relay infrastructure (WireGuard encryption isolates the data)

The orchestrator provisions, starts, stops, and destroys Headscale instances. It acts on tenant lifecycle events.

## Consequences

- Memory and port use grow linearly for each tenant. Headscale uses ~30MB RSS for each instance, so 100 tenants use ~3GB. A single host can handle this.
- We need a reverse proxy. It routes each subdomain to the correct instance port.
- We need a process supervisor (systemd, Docker, or in-process) for the instance lifecycle.
- SQLite for each tenant means no shared DB connection pooling. It also means no multi-tenant query bugs.
- Upgrades are simple. Update the Headscale binary, then restart all instances.

## Future considerations

- If we reach 500+ tenants on a single host, evaluate the fork approach or move to K8s with resource limits for each pod.
- Consider instance hibernation. The system stops idle instances and restarts them on the first connection. This reduces resource use for inactive tenants.
