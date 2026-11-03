# ADR-0011: Traversal policy engine

**Status:** Implemented
**Date:** 2026-11-02
**Priority:** P0
**Depends On:** ADR-0010 (federation control plane)

## Context

The current security model handles intra-collective permissions well.
ADR-0005 gives each collective a composable role system. ADR-0007
introduced federation links with accept/reject lifecycle and CIDR
sharing. ADR-0009 added hierarchical tenancy, creating nested boundaries
at every level of the tree.

None of these answer the core question: **who can cross which boundary,
when, and under what conditions?** Federation links are binary
(active/revoked) with no granular policy. Hierarchical tenancy creates
boundaries but has no traversal semantics. The role system is scoped to
a single collective and cannot express cross-boundary rules.

As atproto-tailnet evolves into an "internet of internets" — hierarchical
federated private networks where AT Protocol identity is the passport —
it needs a unified policy engine that evaluates every cross-boundary
request. This is the customs and immigration system of the hierarchy.

## Decision

### Traversal Policy Engine (TPE)

A new `policy-engine` module intercepts every cross-boundary request and
returns an allow/deny verdict with a full audit trace. Two primitives:

**Traversal Request** — a tuple of:
- `identity` — the DID of the requesting user or agent
- `sourceCollective` — the collective the request originates from
- `destinationCollective` — the collective the request targets
- `requestedResources` — subnets, services, or ports being accessed
- `timestamp` — when the request was made (for time-window evaluation)

**Policy Rule** — a declarative rule that evaluates a traversal request
and returns `allow`, `deny`, or `delegate`. Rules are composable: a
policy is an ordered list of rules evaluated top-to-bottom, first match
wins (with an implicit deny-all default).

### Rule types

Nine built-in rule types cover the policy vocabulary:

- `identity-match` — allow/deny specific DIDs, DID prefix patterns, or
  "members-of(collective-id)" to match an entire roster
- `time-window` — restrict traversal to specific hours, days, or date
  ranges (business hours, maintenance windows)
- `resource-scope` — constrain access to specific CIDRs, service names,
  or port ranges within the destination
- `depth-limit` — cap how many hierarchy levels a traversal can cross
  (prevents leaf-to-distant-cousin hops)
- `reputation-gate` — require minimum trust score (stub: allows all
  until web-of-trust integration lands)
- `bandwidth-cap` — rate-limit cross-boundary traffic per identity or
  source collective (token-bucket per boundary pair)
- `mutual-requirement` — require reciprocal active federation link.
  Specifically, this checks whether the destination collective has an
  active federation link back to the source collective. If no reciprocal
  link exists, the rule's configured action fires (typically `deny`).
- `collective-identity` — match on collective DIDs rather than user
  DIDs. Evaluates collective-to-collective authorization for federation
  handshakes (ADR-0014). Where `identity-match` governs user traversals,
  this rule type governs whether two collectives may federate at all.
- `delegate` — defer decision to a parent or child collective's engine.
  Delegation has a configurable timeout (default 5s). On timeout, the
  evaluator uses the last cached result for that delegation target (max
  staleness: 1 hour). If no cached result exists and delegation times
  out, the implicit default-deny applies. This prevents a single
  unreachable collective from blocking all cross-boundary decisions.

### Policy inheritance

Parent collectives govern children through two constraint types:

- **Floor policies** — minimum rules all children must enforce (e.g.,
  mandate mutual federation). Children inherit floors automatically and
  cannot weaken them.
- **Ceiling policies** — maximum access children can grant (e.g., cap
  depth-limit at 2, restrict resource-scope to certain subnets).
  Children can be stricter but never more permissive.

Conflict resolution is deterministic: floors are unioned across all
ancestors, ceilings are intersected (most restrictive ancestor wins). A
child's own rules evaluate within the envelope that inherited floors and
ceilings define.

### Policy evaluation order

Every cross-boundary traversal is evaluated in three stages — all must
return `allow` for the traversal to proceed:

1. **Egress** — source collective's outbound policy
2. **Intermediate boundaries** — each hierarchy level crossed in path
   order (e.g., child to uncle traverses the shared parent)
3. **Ingress** — destination collective's inbound policy

A `deny` at any stage short-circuits. A `delegate` result chains to the
named collective's engine and continues evaluation there.

### Enforcement architecture

The TPE operates at the **control plane**, not the data plane. WireGuard
operates at L3 with public keys — there is no per-packet DID inspection.
Instead the TPE governs three enforcement points:

- **Connection-time check** — whether relay nodes (ADR-0010) are
  provisioned for a traversal. The TPE evaluates policy before any relay
  infrastructure is stood up for a cross-boundary session.
- **Session-time check** — whether auth keys or WireGuard configurations
  are issued to a user for cross-network access. Key issuance is the
  identity-to-cryptographic-key binding point.
- **Route advertisement filtering** — which routes are propagated across
  federation boundaries. The TPE filters route announcements so only
  policy-permitted prefixes reach peer collectives.

Per-identity bandwidth caps (`bandwidth-cap` rules) are enforced at the
relay node level — relay nodes know which user's session they are
bridging and apply token-bucket limits there. This is coarser-grained
than per-packet inspection: enforcement granularity is per-session and
per-relay, not per-packet. This is an intentional trade-off — per-packet
DID resolution would require deep packet inspection infrastructure that
conflicts with WireGuard's encrypted-tunnel model.

### Policy language

Policies are YAML documents (JSON also accepted) that compile to an
internal evaluation tree — human-readable, version-controllable, diffable:

```yaml
rules:
  - type: mutual-requirement
    action: deny
  - type: identity-match
    match: "members-of(collective-abc)"
    action: allow
  - type: time-window
    hours: "08:00-18:00"
    days: [mon, tue, wed, thu, fri]
    action: allow
  - type: resource-scope
    allow: ["10.0.0.0/24", "tcp/443"]
    action: allow
default: deny
```

Stored per-collective as separate `egress_policy` and `ingress_policy`
documents. Floor/ceiling policies live on the parent and apply during
compilation.

### Extensibility

Collectives can register custom rule evaluators through a plugin
interface — analogous to Kubernetes admission controllers. A custom rule
type declares a name, a JSON schema for its config, and an evaluation
function that receives the traversal request and returns
allow/deny/delegate.

Custom evaluators run in a **WebAssembly (Wasm) sandbox** with strict
resource limits:
- **Execution timeout**: 100ms per evaluation
- **Memory limit**: 16MB
- **No network access**: evaluator cannot make outbound calls
- **No filesystem access**: evaluator cannot read or write host files
- **Read-only input**: evaluator receives a read-only view of the
  traversal request and returns allow/deny — it cannot modify the
  request or any engine state

## Consequences

- **New module**: `policy-engine` with rule parser, compiler, evaluator,
  and audit logger. Components: rule type registry, compilation cache,
  evaluation pipeline, inheritance resolver.
- **Performance-critical path**: every cross-boundary request hits the
  TPE. Mitigation: compiled rules cached per-collective (invalidated on
  policy change), bloom filter accelerates known-allowed identity/boundary
  pairs without full evaluation, hot paths avoid allocation. The bloom
  filter is a **fast-path optimization only** — on a bloom filter miss
  (potential denial), the engine falls through to full policy evaluation.
  False positives in the bloom filter may cause unnecessary full
  evaluations but never produce incorrect deny verdicts. The bloom filter
  only accelerates the common allow case; it never makes final decisions.
- **Deterministic conflict resolution**: floor-union / ceiling-intersect
  eliminates ambiguity. Child rule contradicts parent floor — floor wins.
  Child exceeds ceiling — ceiling wins. No manual resolution needed.
- **Full audit trail**: every traversal decision logged with complete rule
  trace (which rules fired, order, result). Essential for debugging
  misconfigurations and regulatory compliance.
- **UX challenge**: YAML DSL is the power-user interface; the dashboard
  needs a rule builder UI with templates for common patterns ("allow all
  members during business hours," "require mutual federation").
- **Policy authoring permissions**: traversal policy authoring is gated
  by the existing `manage_settings` permission (same gate as federation
  management in ADR-0007) for backward compatibility. A new
  `manage_traversal_policy` permission is added for fine-grained control,
  allowing delegation of policy authoring without granting full settings
  access. Collectives with `manage_settings` implicitly have
  `manage_traversal_policy`.
- **Migration path**: existing federation links (ADR-0007) become a
  special case — active link with no explicit policy equals allow-all
  ingress/egress. TPE is backward-compatible with policy-less collectives.
- **Reputation gate is a stub**: ships as no-op (always allows),
  reserving the interface for future web-of-trust integration.
