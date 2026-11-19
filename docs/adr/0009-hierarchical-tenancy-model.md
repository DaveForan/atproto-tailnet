# ADR-0009: Hierarchical tenancy model

**Status:** In Progress
**Date:** 2026-11-02
**Priority:** P0
**Depends On:** ADR-0002 (multi-tenancy via orchestrated Headscale instances)
**Supersedes (partial):** When the team accepts this ADR, it supersedes the assumption in ADR-0002 that process isolation applies to all tenants. Sub-collectives can use shared-instance mode under the conditions in this ADR. ADR-0013 (Headscale fork with tenant_id scoping and row-level isolation) is a prerequisite. It makes shared-instance mode safe.

## Context

The current tenancy model is flat: one tenant = one Headscale instance = one isolated tailnet. This was the correct starting point (ADR-0002). But a flat model cannot represent the organizational structures that people build:

- A company with regional offices. Each office needs its own device policies, but all offices share one identity system.
- A federated community (for example, mutual aid networks). Local chapters operate independently, but they share infrastructure and trust with the parent.
- A university. Departments, labs, and student organizations each need a private network nested under the institution.
- Activist collectives that split into cells for operational security, but still coordinate.

The "dark forest" thesis makes this need stronger. The open internet becomes more hostile (surveillance, data harvesting, platform enshittification). Communities move into private networks. Isolation alone is not enough. Groups need to organize *hierarchically*. A collective of collectives has sovereignty over its own space and can nest to any depth. The internet stays in place. It becomes the substrate under layers of private, nested networks with bounded trust.

Federation (ADR-0007) addresses peer-to-peer trust between independent tailnets. But federation is bilateral and flat. It cannot express "this network *belongs inside* that network" with inherited policy, delegated resources, and parent/child governance. Hierarchical tenancy is the structural complement to federation.

## Decision

We extend the tenancy model from flat to tree-structured. We rename the core abstraction from "tenant" to **collective**. The new name shows its new role as a recursive organizational unit.

### Core concepts

| Concept | Definition |
|---------|-----------|
| **Collective** | A network unit that has members, devices, policies, and optionally sub-collectives. Replaces "tenant" in user-facing language. |
| **Root collective** | A collective with no parent. Equivalent to today's tenant. |
| **Sub-collective** | A collective nested within a parent. It inherits some policies. It can override other policies within the limits that the parent sets. |
| **Collective tree** | The full hierarchy from a root down through all descendants. Depth has no fixed limit, but resource quotas limit it in practice. |
| **Boundary** | The edge between a collective and its parent or children. The system configures traversal policy (what crosses the boundary and under what conditions) independently at each boundary. |

### Hierarchy rules

**Membership is not inherited.** Membership in a parent collective does not give access to any child. Each collective keeps its own membership. A user who wants to join a sub-collective needs an explicit invitation or join request. The policies of that sub-collective apply.

**Policy inheritance is selective.** Sub-collectives inherit the security baseline of their parent (minimum role permissions, device approval requirements, lockdown state). They can *tighten* the baseline, but they can never *loosen* it. If a parent requires device approval, a child must also require it. A sub-collective can add stricter policies above the inherited floor.

**Floor policy compliance is trust-but-verify.** Sub-collectives operate independently. A parent cannot cryptographically guarantee that children honor the inherited floor policies. Instead, each child reports a compliance attestation every 15 minutes. The attestation is a signed summary of the effective policy configuration of the child. The child checks it against the floor requirements of the parent. The parent compares the attestation with its floor policy. The parent flags non-compliant children. After a configurable grace period (default: 24 hours), the parent can suspend federation and connectivity with a non-compliant child. This is similar to certificate transparency. It does not prevent a violation, but it makes the violation detectable and actionable.

**Visibility is asymmetric.** A parent can see that a child collective exists (name, slug, member count, resource usage). By default, the parent cannot see the internal traffic, device list, or ACLs of the child. Children cannot see the internals of their parent. Both sides can expand visibility by mutual agreement (similar to federation CIDR sharing).

**Independence and ejection.** A sub-collective can declare independence. It detaches from its parent and becomes a new root collective. A parent can eject a child (forced detachment). In both cases, the child keeps its members, devices, and configuration, but it loses the inherited policies. The system writes the detachment to the audit log on both sides.

**Resource grace period on detachment.** A detached collective enters a 30-day grace period. During this period, it continues to operate with the resource allocations it had before detachment (device count, member count, and others). In this period, the collective must establish its own standalone plan. After the grace period ends, resource enforcement applies according to the standalone plan of the collective. If the collective has no plan, the system applies the free-tier defaults and soft-caps the excess resources. A soft cap means no new devices or members until the counts are under the limits. The system does not forcibly remove existing devices or members.

**Resource quotas cascade.** A root collective has a plan with resource limits (devices, members, sub-collectives). It allocates parts of these limits to its children. The children can subdivide their allocation for their own children. A child can never exceed the allocation from its parent. The sum of all child allocations cannot exceed the total of the parent.

### Schema changes

The `tenants` table (renamed to `collectives` through a migration alias or view) gains these columns:

```
parent_id     UUID REFERENCES collectives(id) ON DELETE RESTRICT  -- null = root; parent cannot be deleted while children exist
path          LTREE NOT NULL DEFAULT ''                           -- materialized path for fast tree queries
depth         INTEGER NOT NULL DEFAULT 0                          -- computed from path, denormalized for limits
max_sub_collectives  INTEGER                                      -- quota allocated by parent
```

The PostgreSQL `ltree` extension provides efficient tree queries:

- All descendants: `WHERE path <@ 'root.child'`
- All ancestors: `WHERE 'root.child.grandchild' <@ path`
- Direct children: `WHERE parent_id = :id`
- Depth check: `WHERE depth < :maxDepth`

A `GIST` index on `path` enables sub-millisecond tree traversal at scale.

**Slug constraints:** Collective slugs in ltree paths must match `[a-z0-9_]+` (lowercase alphanumeric characters and underscore only). This prevents ltree path injection. Dots and special characters have syntactic meaning in ltree expressions. The API layer enforces the constraint (Zod validation). A `CHECK` constraint on the `slug` column also enforces it.

**Parent deletion semantics:** `ON DELETE RESTRICT` prevents orphaned children. Without it, the database silently sets `parent_id` to null. This corrupts the ltree `path`, because the path of a child includes the slugs of its ancestors. To delete a parent collective, the API layer must first recursively detach or delete all descendants. This is an explicit cascade operation in the `collective-tree.ts` service. It is not a DB cascade constraint.

### Headscale mapping

The originator chooses one of two strategies for each sub-collective at creation time:

1. **Dedicated instance** (default): The sub-collective gets its own Headscale container, like today's tenants. It has full process-level isolation. The resource cost is higher, and it counts against the quota of the parent. This is the default because ADR-0002 rejected ACL-based isolation. Within a single Headscale instance, DNS, DERP, IP pool, and node enumeration all leak across namespaces.

2. **Shared instance** (opt-in only): The sub-collective gets a Headscale user or namespace within the Headscale instance of the parent. The overhead is lower, and the isolation is weaker. The originator of the parent must opt in explicitly and accept the isolation tradeoffs (documented in ADR-0002). **Enable this mode only after ADR-0013 (Headscale fork) is complete.** ADR-0013 adds tenant_id scoping and row-level isolation. These make namespace separation safe. Until then, shared-instance mode is not available.

The originator of the parent makes this choice at sub-collective creation time. The originator can change it later (migration causes downtime).

### API changes

We add new endpoints under the existing tenant/collective resource:

```
POST   /api/collectives/:id/sub-collectives           -- create sub-collective
GET    /api/collectives/:id/sub-collectives            -- list direct children
GET    /api/collectives/:id/tree                       -- full descendant tree (paginated)
GET    /api/collectives/:id/ancestors                  -- path to root
POST   /api/collectives/:id/detach                     -- declare independence
POST   /api/collectives/:id/eject/:childId             -- parent ejects child
PUT    /api/collectives/:id/sub-collectives/:childId/quota  -- adjust child's resource allocation
```

The existing `/api/tenants/*` routes remain as aliases during migration. A new `manage_sub_collectives` permission gates the hierarchy operations (create, detach, eject, quota adjustment). This is the **17th permission** in `ALL_PERMISSIONS` in `src/routes/permissions.ts`. It extends the permission system from ADR-0005. Like the existing permissions, administrators can assign it to custom roles through the role builder. It also intersects with agent token scopes.

### Dashboard changes

The dashboard gains these features:

- **Tree navigator**: a collapsible sidebar or breadcrumb trail that shows the collective hierarchy. When the user clicks a node, the dashboard switches to the context of that collective.
- **Breadcrumbs**: a `Root > Regional > Local` path indicator on every dashboard page.
- **Sub-collectives tab**: lists children and lets the user create children, manage quotas, and eject children.
- **Context indicator**: a clear visual signal of the collective that the user views now. This prevents accidental configuration of the wrong level.

## Consequences

- **Migration path**: existing tenants become root collectives with `parent_id = NULL`, `path = slug`, `depth = 0`. The migration has zero downtime, because the new columns are nullable or have defaults.
- **ltree dependency**: the system needs the PostgreSQL `ltree` extension. All major managed Postgres providers offer it (RDS, Cloud SQL, Supabase). Enable it with `CREATE EXTENSION IF NOT EXISTS ltree`.
- **Query complexity**: tree queries (descendants, ancestors, subtree aggregation) are efficient with ltree and a GIST index. They are more complex than flat queries. A `collective-tree.ts` service module must contain all tree queries. Do not spread them across route handlers.
- **Quota accounting**: when the system creates or resizes a sub-collective, it must check the unallocated resources of the parent. This is a read-modify-write cycle. It needs row-level locking (`SELECT ... FOR UPDATE` on the parent) to prevent overallocation with concurrent requests.
- **Headscale namespace mode**: shared-instance mode is opt-in only. It stays blocked until ADR-0013 (Headscale fork) is complete. Dedicated-instance mode is the default. It preserves the process-level isolation guarantee of ADR-0002. After ADR-0013 adds tenant_id scoping and row-level isolation, shared-instance mode becomes available. Parent originators who explicitly accept the reduced isolation boundary can use it.
- **Floor policy compliance**: the attestation mechanism adds a periodic background job for each parent-child boundary. In deep trees with many children, this generates O(N) attestation checks in each cycle. The 15-minute interval and the fire-and-forget architecture keep this manageable. Operators must monitor the attestation backlog.
- **Federation interaction**: federation links (ADR-0007) attach to one collective, not to the whole tree. A federation link on a parent does not extend to children automatically. Sub-collectives that need federation must establish their own links (if they have the permission).
- **Audit trail**: the system writes hierarchy operations (create sub-collective, detach, eject, quota change) to the audit log. Each entry has the IDs of both the parent and the child collective for traceability.
- **Depth limits**: the model supports any depth. A practical default limit (for example, 8 levels) prevents pathological trees and simplifies UI rendering. Each root collective can configure this limit.

## Future considerations

- **Cross-tree traversal**: two collectives in different trees can need a boundary link (like federation, but with parent/child semantics). This is out of scope for the first implementation.
- **Collective templates**: pre-configured sub-collective archetypes (for example, "department", "working group", "cell"). They set default policies, quotas, and the Headscale mode. This reduces the configuration work for common patterns.
- **Visual topology**: a graph view that shows the full collective tree with the federation links overlaid. It gives originators a map of their network-of-networks.
- **Recursive delegation**: sub-collective originators can delegate the right to create sub-collectives. The quota bounds cascade down. This needs careful UX design to prevent confusion about who controls what.
