# ADR-0009: Hierarchical tenancy model

**Status:** In Progress
**Date:** 2026-11-02
**Priority:** P0
**Depends On:** ADR-0002 (multi-tenancy via orchestrated Headscale instances)
**Supersedes (partial):** When accepted, this ADR supersedes ADR-0002's assumption that all tenants are process-isolated. Sub-collectives may use shared-instance mode under the conditions described below. ADR-0013 (Headscale fork with tenant_id scoping and row-level isolation) is the prerequisite for making shared-instance mode safe.

## Context

The current tenancy model is flat: one tenant = one Headscale instance = one isolated tailnet. This was the right starting point (ADR-0002), but flat tenancy cannot model the organizational structures people actually build:

- A company with regional offices, each needing its own device policies but unified identity
- A federated community (e.g., mutual aid networks) where local chapters operate independently but share infrastructure and trust with the parent
- A university where departments, labs, and student orgs each need private networks nested under the institution
- Activist collectives that split into cells for operational security but still coordinate

The "dark forest" thesis sharpens this further. As the open internet grows more hostile — surveillance, data harvesting, platform enshittification — communities retreat into private networks. But isolation alone is insufficient. Groups need to organize *hierarchically*: a collective of collectives, each with sovereignty over its own space, able to nest arbitrarily deep. The internet doesn't go away; it becomes the substrate beneath layers of private, nested, trust-bounded networks.

Federation (ADR-0007) addresses peer-to-peer trust between independent tailnets. But federation is bilateral and flat — it cannot express "this network *belongs inside* that network" with inherited policy, delegated resources, and parent/child governance. Hierarchical tenancy is the structural complement to federation.

## Decision

Extend the tenancy model from flat to tree-structured. Rename the core abstraction from "tenant" to **collective** to reflect its new role as a recursive organizational unit.

### Core concepts

| Concept | Definition |
|---------|-----------|
| **Collective** | A network unit that has members, devices, policies, and optionally sub-collectives. Replaces "tenant" in user-facing language. |
| **Root collective** | A collective with no parent. Equivalent to today's tenant. |
| **Sub-collective** | A collective nested within a parent. Inherits some policies, can override others within bounds set by the parent. |
| **Collective tree** | The full hierarchy from a root down through all descendants. Depth is unbounded but practically limited by resource quotas. |
| **Boundary** | The edge between a collective and its parent or children. Traversal policy (what crosses the boundary and under what conditions) is configured at each boundary independently. |

### Hierarchy rules

**Membership is not inherited.** Belonging to a parent collective does not grant access to any child. Each collective maintains its own membership, and joining a sub-collective requires explicit invitation or join-request, subject to that sub-collective's own policies.

**Policy inheritance is selective.** Sub-collectives inherit their parent's security baseline (minimum role permissions, device approval requirements, lockdown state) but can *tighten*, never *loosen*. A parent that requires device approval cannot have a child that doesn't. A sub-collective can add stricter policies beyond the inherited floor.

**Floor policy compliance is trust-but-verify.** Because sub-collectives are operationally independent, a parent cannot cryptographically guarantee that children honor inherited floor policies. Instead, children periodically (every 15 minutes) report a compliance attestation: a signed summary of their effective policy configuration checked against the parent's floor requirements. The parent compares this attestation against its floor policy. Non-compliant children are flagged, and the parent can suspend federation/connectivity with a non-compliant child after a configurable grace period (default: 24 hours). This is analogous to certificate transparency — it does not prevent violation but makes violation detectable and actionable.

**Visibility is asymmetric.** A parent can see that a child collective exists (name, slug, member count, resource usage) but cannot see the child's internal traffic, device list, or ACLs by default. Children see nothing about their parent's internals. Visibility can be selectively expanded by mutual agreement (similar to federation CIDR sharing).

**Independence and ejection.** A sub-collective can declare independence (detach from its parent, becoming a new root collective). A parent can eject a child (forcibly detach). In both cases, the child retains its members, devices, and configuration but loses inherited policies. Detachment is audit-logged on both sides.

**Resource grace period on detachment.** A detached collective enters a 30-day grace period during which it continues to operate with its pre-detachment resource allocations (device count, member count, etc.). During this period, the collective must establish its own standalone plan. After the grace period expires, resource enforcement applies per the collective's standalone plan — if no plan is set, the system's free-tier defaults apply and excess resources are soft-capped (no new devices/members until under limits, but existing ones are not forcibly removed).

**Resource quotas cascade.** A root collective has a plan with resource limits (devices, members, sub-collectives). It allocates portions of those limits to children, who can further subdivide to their own children. A child can never exceed what its parent allocated, and the sum of all children's allocations cannot exceed the parent's total.

### Schema changes

The `tenants` table (renamed to `collectives` via migration alias or view) gains:

```
parent_id     UUID REFERENCES collectives(id) ON DELETE RESTRICT  -- null = root; parent cannot be deleted while children exist
path          LTREE NOT NULL DEFAULT ''                           -- materialized path for fast tree queries
depth         INTEGER NOT NULL DEFAULT 0                          -- computed from path, denormalized for limits
max_sub_collectives  INTEGER                                      -- quota allocated by parent
```

PostgreSQL's `ltree` extension provides efficient tree queries:

- All descendants: `WHERE path <@ 'root.child'`
- All ancestors: `WHERE 'root.child.grandchild' <@ path`
- Direct children: `WHERE parent_id = :id`
- Depth check: `WHERE depth < :maxDepth`

An index on `path` using `GIST` enables sub-millisecond tree traversal even at scale.

**Slug constraints:** Collective slugs used in ltree paths must match `[a-z0-9_]+` (lowercase alphanumeric and underscore only). This prevents ltree path injection via dots or special characters that have syntactic meaning in ltree expressions. The constraint is enforced at the API layer (Zod validation) and as a `CHECK` constraint on the `slug` column.

**Parent deletion semantics:** `ON DELETE RESTRICT` prevents orphaning children by silently nulling `parent_id`, which would corrupt the ltree `path` (a child's path includes its ancestors' slugs). To delete a parent collective, the API layer must first recursively detach or delete all descendants — this is an explicit cascade operation in the `collective-tree.ts` service, not a DB cascade constraint.

### Headscale mapping

Two strategies, chosen per sub-collective at creation time:

1. **Dedicated instance** (default): Sub-collective gets its own Headscale container, like today's tenants. Full process-level isolation. Higher resource cost, counted against parent's quota. This is the default because ADR-0002 rejected ACL-based isolation — DNS, DERP, IP pool, and node enumeration all leak across namespaces within a single Headscale instance.

2. **Shared instance** (opt-in only): Sub-collective gets a Headscale user/namespace within the parent's Headscale instance. Lower overhead, weaker isolation. The parent's originator must explicitly opt in and accept the isolation tradeoffs (documented in ADR-0002). **This mode should only be enabled after ADR-0013 (Headscale fork) lands**, which adds tenant_id scoping and row-level isolation to make namespace separation safe. Until then, shared-instance mode is unavailable.

The choice is made by the parent's originator at sub-collective creation time and can be changed later (with downtime for migration).

### API changes

New endpoints under the existing tenant/collective resource:

```
POST   /api/collectives/:id/sub-collectives           -- create sub-collective
GET    /api/collectives/:id/sub-collectives            -- list direct children
GET    /api/collectives/:id/tree                       -- full descendant tree (paginated)
GET    /api/collectives/:id/ancestors                  -- path to root
POST   /api/collectives/:id/detach                     -- declare independence
POST   /api/collectives/:id/eject/:childId             -- parent ejects child
PUT    /api/collectives/:id/sub-collectives/:childId/quota  -- adjust child's resource allocation
```

Existing `/api/tenants/*` routes remain as aliases during migration. A new `manage_sub_collectives` permission gates hierarchy operations (create, detach, eject, quota adjustment). This is the **17th permission** added to `ALL_PERMISSIONS` in `src/routes/permissions.ts`, extending the permission system defined in ADR-0005. Like existing permissions, it is assignable to custom roles via the role builder and intersectable with agent token scopes.

### Dashboard changes

The dashboard gains:

- **Tree navigator**: collapsible sidebar or breadcrumb trail showing the collective hierarchy. Clicking a node switches context to that collective's dashboard.
- **Breadcrumbs**: `Root > Regional > Local` path indicator on every dashboard page.
- **Sub-collectives tab**: list children, create new, manage quotas, eject.
- **Context indicator**: clear visual signal of which collective you're currently viewing, to prevent accidental configuration of the wrong level.

## Consequences

- **Migration path**: existing tenants become root collectives with `parent_id = NULL`, `path = slug`, `depth = 0`. Zero-downtime migration since the new columns are nullable/defaulted.
- **ltree dependency**: requires the PostgreSQL `ltree` extension. Available in all major managed Postgres providers (RDS, Cloud SQL, Supabase). Must be enabled via `CREATE EXTENSION IF NOT EXISTS ltree`.
- **Query complexity**: tree queries (descendants, ancestors, subtree aggregation) are efficient with ltree + GIST index but more complex than flat queries. All tree queries should be encapsulated in a `collective-tree.ts` service module, not scattered across route handlers.
- **Quota accounting**: creating or resizing a sub-collective requires checking the parent's remaining unallocated resources. This is a read-modify-write cycle that needs row-level locking (`SELECT ... FOR UPDATE` on the parent) to prevent overallocation under concurrent requests.
- **Headscale namespace mode**: shared-instance is opt-in only and blocked until ADR-0013 (Headscale fork) lands. Dedicated-instance is the default, preserving ADR-0002's process-level isolation guarantee. Once ADR-0013 adds tenant_id scoping and row-level isolation, shared-instance becomes available for parent originators who explicitly accept the reduced isolation boundary.
- **Floor policy compliance**: the attestation mechanism adds a periodic background job per parent-child boundary. At scale (deep trees with many children), this generates O(N) attestation checks per cycle. The 15-minute interval and fire-and-forget architecture keep this manageable, but monitoring the attestation backlog is required.
- **Federation interaction**: federation links (ADR-0007) attach to a specific collective, not the whole tree. A federation link on a parent does not automatically extend to children. Sub-collectives that need federation must establish their own links (if they have the permission).
- **Audit trail**: hierarchy operations (create sub-collective, detach, eject, quota change) are audit-logged with both parent and child collective IDs for traceability.
- **Depth limits**: while the model supports arbitrary depth, a practical default limit (e.g., 8 levels) prevents pathological trees and simplifies UI rendering. Configurable per root collective.

## Future considerations

- **Cross-tree traversal**: two collectives in different trees might want to establish a boundary link (like federation but with parent/child semantics). This is out of scope for the initial implementation.
- **Collective templates**: pre-configured sub-collective archetypes (e.g., "department", "working group", "cell") that set default policies, quotas, and Headscale mode. Reduces configuration burden for common patterns.
- **Visual topology**: a graph view showing the full collective tree with federation links overlaid, giving originators a map of their network-of-networks.
- **Recursive delegation**: allowing sub-collective originators to further delegate sub-collective creation rights, with quota bounds cascading down. Requires careful UX to prevent confusion about who controls what.
