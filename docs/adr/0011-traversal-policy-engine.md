# ADR-0011: Traversal policy engine

**Status:** Implemented
**Date:** 2026-11-02
**Priority:** P0
**Depends On:** ADR-0010 (federation control plane)

## Context

The current security model handles permissions inside a collective well.
ADR-0005 gives each collective a composable role system. ADR-0007
introduced federation links with an accept/reject lifecycle and CIDR
sharing. ADR-0009 added hierarchical tenancy. It creates nested boundaries
at every level of the tree.

None of these answer the core question: **who can cross which boundary,
when, and under what conditions?** Federation links are binary
(active/revoked) and have no granular policy. Hierarchical tenancy creates
boundaries, but it has no traversal semantics. The role system applies to
a single collective. It cannot express rules for crossing boundaries.

atproto-tailnet is evolving into an "internet of internets". These are
hierarchical, federated private networks, and the AT Protocol identity is
the passport. The system needs one policy engine that evaluates every
cross-boundary request. This engine is the customs and immigration system
of the hierarchy.

## Decision

### Traversal Policy Engine (TPE)

A new `policy-engine` module intercepts every cross-boundary request. It
returns an allow/deny verdict with a full audit trace. It has two
primitives:

**Traversal Request** is a tuple of these fields:
- `identity`: the DID of the requesting user or agent
- `sourceCollective`: the collective that the request comes from
- `destinationCollective`: the collective that the request targets
- `requestedResources`: the subnets, services, or ports that the request accesses
- `timestamp`: the time of the request (for time-window evaluation)

**Policy Rule** is a declarative rule that evaluates a traversal request.
It returns `allow`, `deny`, or `delegate`. Rules are composable. A
policy is an ordered list of rules. The engine evaluates them from top to
bottom, and the first match wins. The implicit default is deny-all.

### Rule types

The engine has nine built-in rule types for the policy vocabulary:

- `identity-match`: allow or deny specific DIDs, DID prefix patterns, or
  "members-of(collective-id)" to match an entire roster
- `time-window`: restrict traversal to specific hours, days, or date
  ranges (business hours, maintenance windows)
- `resource-scope`: limit access to specific CIDRs, service names,
  or port ranges in the destination
- `depth-limit`: limit the number of hierarchy levels that a traversal can
  cross (prevents hops from a leaf to a distant cousin)
- `reputation-gate`: require a minimum trust score (stub: it allows all
  requests until the web-of-trust integration is available)
- `bandwidth-cap`: rate-limit cross-boundary traffic for each identity or
  source collective (token-bucket for each boundary pair)
- `mutual-requirement`: require a reciprocal active federation link.
  This rule checks if the destination collective has an
  active federation link back to the source collective. If no reciprocal
  link exists, the configured action of the rule runs (usually `deny`).
- `collective-identity`: match on collective DIDs, not user
  DIDs. It evaluates collective-to-collective authorization for federation
  handshakes (ADR-0014). `identity-match` governs user traversals.
  This rule type governs whether two collectives can federate at all.
- `delegate`: defer the decision to the engine of a parent or child
  collective. Delegation has a configurable timeout (default 5s). On
  timeout, the evaluator uses the last cached result for that delegation
  target (maximum age: 1 hour). If no cached result exists and the delegation
  times out, the implicit default-deny applies. This prevents one
  unreachable collective from blocking all cross-boundary decisions.

### Policy inheritance

Parent collectives govern children with two constraint types:

- **Floor policies**: minimum rules that all children must enforce (for
  example, require mutual federation). Children inherit floors automatically
  and cannot weaken them.
- **Ceiling policies**: maximum access that children can grant (for example,
  limit depth-limit to 2, or restrict resource-scope to certain subnets).
  Children can be stricter, but never more permissive.

Conflict resolution is deterministic. The engine unions floors across all
ancestors. It intersects ceilings (the most restrictive ancestor wins). The
own rules of a child evaluate inside the envelope that the inherited floors
and ceilings define.

### Policy evaluation order

The engine evaluates every cross-boundary traversal in three stages. All
stages must return `allow` before the traversal proceeds:

1. **Egress**: the outbound policy of the source collective
2. **Intermediate boundaries**: each hierarchy level that the path crosses,
   in path order (for example, a child to uncle traversal crosses the shared
   parent)
3. **Ingress**: the inbound policy of the destination collective

A `deny` at any stage stops the evaluation. A `delegate` result chains to
the engine of the named collective, and the evaluation continues there.

### Enforcement architecture

The TPE operates at the **control plane**, not the data plane. WireGuard
operates at L3 with public keys. It has no per-packet DID inspection.
Instead, the TPE governs three enforcement points:

- **Connection-time check**: decides if the system provisions relay nodes
  (ADR-0010) for a traversal. The TPE evaluates policy before the system
  starts any relay infrastructure for a cross-boundary session.
- **Session-time check**: decides if the system issues auth keys or WireGuard
  configurations to a user for cross-network access. Key issuance is the
  point that binds an identity to a cryptographic key.
- **Route advertisement filtering**: decides which routes propagate across
  federation boundaries. The TPE filters route announcements. Only
  prefixes that policy permits reach peer collectives.

The system enforces per-identity bandwidth caps (`bandwidth-cap` rules) at
the relay node level. Relay nodes know the user session that they bridge.
They apply token-bucket limits for that session. This is coarser than
per-packet inspection. The enforcement granularity is per session and per
relay, not per packet. This is an intentional trade-off. Per-packet DID
resolution needs deep packet inspection infrastructure. That conflicts with
the encrypted-tunnel model of WireGuard.

### Policy language

Policies are YAML documents (JSON is also accepted). They compile to an
internal evaluation tree. They are human-readable, version-controllable, and
diffable:

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

The system stores the policies for each collective as separate `egress_policy` and `ingress_policy`
documents. Floor and ceiling policies live on the parent. They apply during
compilation.

### Extensibility

Collectives can register custom rule evaluators through a plugin
interface. This is similar to Kubernetes admission controllers. A custom
rule type declares a name, a JSON schema for its config, and an evaluation
function. The function receives the traversal request and returns
allow/deny/delegate.

Custom evaluators run in a **WebAssembly (Wasm) sandbox** with strict
resource limits:
- **Execution timeout**: 100ms for each evaluation
- **Memory limit**: 16MB
- **No network access**: the evaluator cannot make outbound calls
- **No filesystem access**: the evaluator cannot read or write host files
- **Read-only input**: the evaluator receives a read-only view of the
  traversal request and returns allow/deny. It cannot modify the
  request or any engine state

## Consequences

- **New module**: `policy-engine` with a rule parser, a compiler, an evaluator,
  and an audit logger. Components: rule type registry, compilation cache,
  evaluation pipeline, inheritance resolver.
- **Performance-critical path**: every cross-boundary request uses the
  TPE. Mitigations: the system caches compiled rules for each collective
  (it invalidates the cache when the policy changes). A bloom filter
  accelerates known-allowed identity and boundary pairs without full
  evaluation. Hot paths avoid allocation. The bloom filter is a
  **fast-path optimization only**. On a bloom filter miss (a potential
  denial), the engine runs the full policy evaluation. False positives in
  the bloom filter can cause unnecessary full evaluations. They never
  produce incorrect deny verdicts. The bloom filter only accelerates the
  common allow case. It never makes final decisions.
- **Deterministic conflict resolution**: floor-union and ceiling-intersect
  remove ambiguity. If a child rule contradicts a parent floor, the floor
  wins. If a child exceeds a ceiling, the ceiling wins. Nobody needs to
  resolve conflicts manually.
- **Full audit trail**: the system logs every traversal decision with the
  complete rule trace (which rules ran, their order, and the result). This
  is essential to debug misconfigurations and for regulatory compliance.
- **UX challenge**: the YAML DSL is the interface for power users. The
  dashboard needs a rule builder UI with templates for common patterns
  ("allow all members during business hours," "require mutual federation").
- **Policy authoring permissions**: the existing `manage_settings` permission
  gates traversal policy authoring (the same gate as federation
  management in ADR-0007). This keeps backward compatibility. We add a new
  `manage_traversal_policy` permission for fine-grained control. With it,
  an administrator can delegate policy authoring without full settings
  access. Collectives with `manage_settings` implicitly have
  `manage_traversal_policy`.
- **Migration path**: existing federation links (ADR-0007) become a
  special case. An active link with no explicit policy equals allow-all
  ingress and egress. The TPE is backward-compatible with collectives that
  have no policy.
- **Reputation gate is a stub**: it ships as a no-op (it always allows).
  It reserves the interface for a future web-of-trust integration.
