# ADR-0002: Multi-tenancy via orchestrated Headscale instances

**Status:** Accepted
**Date:** 2026-10-23

## Context

Headscale is fundamentally single-tenant: one instance = one tailnet. The maintainers have explicitly rejected multi-tenancy as out of scope (issue #2711). We need multiple isolated tailnets for our service.

### Options considered

| Option | Effort | Isolation | Maintenance burden |
|--------|--------|-----------|-------------------|
| **A: Fork Headscale, add tenant_id** | 4-8 weeks MVP, 5-7K LOC changes across ~70 files | Full (if done right) | High — must rebase against every upstream release. Headscale evolves fast (v0.29.1, active development). |
| **B: ACL-based isolation within single instance** | 1 week | Partial — blocks data-plane traffic but DNS, DERP, IP pool, and node enumeration all leak across tenants. | Low — no fork. |
| **C: One Headscale instance per tenant (orchestrator)** | 2-3 weeks for orchestrator | Perfect — separate processes, DBs, configs, DNS domains. | Low — use upstream unmodified. Ops cost scales linearly with tenants. |

### Fork feasibility assessment (Option A)

We conducted a deep analysis of the Headscale codebase (see `research_notes/`):

- **Cylonix fork** proves it's possible: ~4K lines across 73 files, 79 commits. Added Namespace + NetworkDomain dimensions with 4-tier auth.
- **Subsystem difficulty**: Database (Medium), API v2 (Easy-Medium, `{tailnet}` param already in URLs), Policy (Medium, already parameterized on user/node lists), DNS (Easy, follows from netmap isolation), DERP (Easy, shared is fine), State singleton (Hard, 115 methods assume global state), Tests (Hard, 122K LOC assume single tenant).
- **Risk**: Cylonix fork was against an older Headscale. Current codebase has evolved significantly (NodeStore copy-on-write, change.Change system, credentials unification, v2 API). Fork maintenance is the real cost, not the initial implementation.

### Why we chose Option C

1. **Zero fork maintenance** — use upstream Headscale as-is, track releases trivially.
2. **Perfect isolation by default** — no chance of cross-tenant data leaks; each tenant gets its own process, database, and DNS domain.
3. **Our differentiator is the identity layer** (AT Proto), not the control plane internals. Engineering time is better spent there.
4. **Escape hatch exists** — if we hit a scaling wall (hundreds of tenants where per-tenant containers are expensive), we can fork then, informed by real usage patterns rather than speculation.
5. **Operational cost is manageable** — Headscale is lightweight (single Go binary, SQLite). A single host can run dozens of instances. We can scale to containers/K8s later.

## Decision

Run **one Headscale instance per tenant**, managed by an orchestration service. Each instance gets:

- Its own SQLite database
- Its own DNS subdomain (`<tenant-slug>.atproto-tailnet.example.com`)
- Its own config file (generated from template)
- Its own listening port (reverse-proxied via Caddy/Nginx)
- Shared DERP relay infrastructure (WireGuard encryption provides data isolation)

The orchestrator provisions, starts, stops, and destroys Headscale instances in response to tenant lifecycle events.

## Consequences

- Memory/port usage scales linearly per tenant. Headscale is ~30MB RSS per instance, so 100 tenants ≈ 3GB — manageable on a single host.
- Need a reverse proxy that routes by subdomain to the correct instance port.
- Need a process supervisor (systemd, Docker, or in-process) for instance lifecycle.
- SQLite per tenant means no shared DB connection pooling, but also no multi-tenant query bugs.
- Upgrades are simple: update the Headscale binary, restart all instances.

## Future considerations

- If we reach 500+ tenants on a single host, evaluate the fork approach or move to K8s with resource limits per pod.
- Consider instance hibernation (stop idle instances, restart on first connection) to reduce resource usage for inactive tenants.
