# ADR-0023: Rust mesh coordinator

**Status:** Accepted
**Date:** 2026-11-06
**Priority:** P0
**Depends On:** ADR-0009 (hierarchical tenancy), ADR-0010 (federation control plane)
**Supersedes:** ADR-0001 (Headscale as control plane), ADR-0002 (container-per-tenant), ADR-0013 (Go fork)

## Context

ADR-0013 proposed forking Headscale in Go to add multi-tenant namespace
separation. That approach preserves access to Tailscale's Go libraries but
inherits Go's type system limitations and Headscale's single-tenant
architecture — every multi-tenant invariant must be enforced by convention
and testing, never by the compiler. ADR-0013 explicitly noted this as an
accepted tradeoff.

Revisiting that tradeoff: the project is not Tailscale. It is a
hierarchical federated mesh network with AT Proto identity, credential-gated
traversal, and per-hop policy enforcement. Every layer inherited from
Tailscale/Headscale — the single-coordinator assumption, the flat namespace
model, the account-based auth, the monolithic netmap — fights the
architecture this project needs.

The protocol layers underneath are well-specified and have production Rust
implementations:

- **WireGuard**: `boringtun` (Cloudflare, production-grade userspace
  implementation), plus the kernel module for Linux data plane
- **Noise IK**: `snow` crate (Noise protocol framework, audited)
- **DERP relay**: Simple HTTP upgrade + binary framing protocol, ~500 lines
  to implement
- **STUN/NAT traversal**: `stun-rs`, `webrtc-rs` crates

What Headscale provides beyond these primitives is coordination logic:
netmap generation, node registration, key management, ACL evaluation, and
the HTTP/Noise transport that Tailscale clients speak. That coordination
logic is exactly what needs to be redesigned for multi-tenancy, federation,
and hierarchical namespaces. Forking it means rewriting it anyway, but
inside someone else's architecture.

### Why Rust

- **Type-level tenant isolation.** A `TenantId` newtype threading through
  every query, every netmap build, every ACL evaluation. The compiler
  catches cross-tenant leaks that Go relies on `WHERE` clauses and code
  review to prevent.
- **Enum-driven protocol states.** Noise handshake states, federation link
  states, traversal credential verification — all as exhaustive enums.
  Invalid state transitions are compilation errors.
- **Memory safety without GC.** A long-running coordinator serving
  thousands of tenants needs predictable latency. No GC pauses, no
  goroutine leaks.
- **Trait-based abstraction.** The coordinator's subsystems (node registry,
  netmap builder, ACL engine, federation broker) compose via traits, not
  interface pollution. Generic over storage backend for testing.
- **Single binary deployment.** No Docker socket, no container-per-tenant,
  no port pool. One process, one binary, one PostgreSQL connection pool.

## Decision

Build a purpose-built mesh coordinator in Rust. Maintain Tailscale client
wire compatibility in Phase 1 so existing `tailscale` CLI works
immediately. Diverge the protocol as the client evolves (ADR-0024).

### Architecture

```
┌──────────────────────────────────────────────────┐
│                  Coordinator                      │
│                                                   │
│  ┌───────────┐  ┌───────────┐  ┌──────────────┐ │
│  │   Noise   │  │   REST    │  │  Federation  │ │
│  │ Transport │  │   API     │  │   Broker     │ │
│  │ (clients) │  │ (mgmt)    │  │  (peers)     │ │
│  └─────┬─────┘  └─────┬─────┘  └──────┬───────┘ │
│        │              │               │          │
│  ┌─────▼──────────────▼───────────────▼───────┐  │
│  │              Tenant Router                  │  │
│  │  TenantId → { NodeRegistry, NetmapBuilder, │  │
│  │              AclEngine, FederationState }   │  │
│  └─────────────────┬──────────────────────────┘  │
│                    │                              │
│  ┌─────────────────▼──────────────────────────┐  │
│  │           Storage (sqlx + PostgreSQL)       │  │
│  │     All queries scoped by TenantId          │  │
│  │     RLS as defense-in-depth                 │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

### Tailscale client compatibility

The Tailscale client connects to its coordinator over HTTPS, upgrading to a
Noise IK session. The coordinator must implement:

1. **`/ts2021` upgrade endpoint** — HTTP upgrade to Noise IK transport.
   The client sends its machine key; the coordinator responds with the
   control key. All subsequent messages are Noise-encrypted.

2. **Control messages over Noise** — The coordinator sends `MapResponse`
   (the netmap: peer list, DERP map, DNS config, ACL rules) and receives
   `MapRequest` (node state updates, endpoint changes). These are protobuf
   or JSON-encoded Tailscale types.

3. **`/key?v=...` endpoint** — Returns the coordinator's Noise public key
   so clients can initiate the handshake.

4. **`/machine/register`** — Pre-auth key registration (legacy path, some
   clients still use it).

5. **DERP map serving** — The coordinator tells clients which DERP relays
   to use. Can point to external Tailscale DERP servers or self-hosted ones.

6. **DNS configuration** — MagicDNS names for nodes within the namespace.

### Multi-tenant model

Every coordinator subsystem is parameterized by `TenantId`:

```rust
struct TenantId(Uuid);

trait NodeRegistry {
    async fn register(&self, tenant: TenantId, node: NodeInfo) -> Result<NodeId>;
    async fn list_peers(&self, tenant: TenantId, node: NodeId) -> Result<Vec<PeerInfo>>;
}

trait NetmapBuilder {
    async fn build(&self, tenant: TenantId, node: NodeId) -> Result<MapResponse>;
}

trait AclEngine {
    fn evaluate(&self, tenant: TenantId, src: NodeId, dst: NodeId, port: u16) -> Verdict;
}
```

Cross-tenant access is impossible unless the type signatures explicitly
carry both tenant IDs (as in federation routing).

### Hierarchical namespaces

Sub-collectives are tenants whose `parent_id` references another tenant.
The netmap builder for a parent tenant can optionally include aggregated
routes from child tenants (subject to policy). This is in-process — no
cross-container orchestration.

```rust
struct Tenant {
    id: TenantId,
    parent_id: Option<TenantId>,
    federation_posture: FederationPosture,
    // ...
}
```

### Federation as a first-class subsystem

The federation broker (currently in TypeScript) moves into the coordinator
as a Rust module. Federation links, the CFP handshake, route exchange, and
relay provisioning are all coordinator-internal operations with direct
access to the netmap and ACL engine. No HTTP round-trips between the
management service and the control plane.

### Project structure

The coordinator lives within the atproto-tailnet repository:

```
coordinator/
  Cargo.toml              — workspace root
  crates/
    coord-core/           — TenantId, NodeId, types, traits
    coord-noise/          — Noise IK transport (snow-based)
    coord-proto/          — Tailscale control protocol messages
    coord-netmap/         — Netmap generation, per-tenant
    coord-acl/            — ACL policy engine
    coord-store/          — PostgreSQL storage (sqlx)
    coord-api/            — REST management API (axum)
    coord-federation/     — Federation broker, CFP protocol
    coord-server/         — Binary entrypoint, wiring
  tests/
    integration/          — Full coordinator + tailscale client tests
```

### Phased implementation

**Phase 1: Minimal compatible coordinator**
- Noise IK transport accepting Tailscale client connections
- Node registration with pre-auth keys
- Single-tenant netmap generation
- REST API for node/key management
- `tailscale up --login-server` works against it

**Phase 2: Multi-tenant and hierarchy**
- TenantId-scoped everything
- Sub-collective namespace tree
- Per-tenant ACL engine
- REST API with tenant context
- TypeScript service delegates to coordinator instead of Headscale

**Phase 3: Federation native**
- Federation broker as coordinator module
- Cross-tenant route advertisement
- Traversal credential verification at the coordinator level
- Relay provisioning integrated

**Phase 4: Protocol divergence**
- Custom control messages for credential presentation
- Namespace-aware DERP relay selection
- Leads into ADR-0024 (purpose-built client)

## Consequences

- **Headscale is removed.** No more container-per-tenant orchestration,
  Docker socket dependency, port allocation pool, or per-container health
  monitoring. The TypeScript service manages the coordinator as a single
  subprocess or sidecar.
- **Tailscale client compatibility is temporary.** Phase 1-3 maintain it.
  Phase 4 begins diverging. ADR-0024 covers the transition.
- **The TypeScript service remains.** It handles AT Proto OAuth, the web
  dashboard, credential issuance, and user management. The coordinator
  handles WireGuard coordination, netmap generation, and ACL enforcement.
  They communicate via REST API and shared PostgreSQL.
- **New language in the project.** Rust joins TypeScript. The coordinator
  is a self-contained workspace with its own CI. The boundary is clean:
  TypeScript is the web layer, Rust is the network layer.
- **Migration from Headscale.** Existing deployments need a data migration
  from per-tenant SQLite databases to the shared PostgreSQL schema. The
  same concern existed in ADR-0013; the solution is the same (iterate
  SQLite files, transform with tenant_id, preserve WireGuard keys).
- **ADR-0013 is superseded.** The Go fork approach is replaced by a
  ground-up Rust implementation. The analysis in ADR-0013 (resource
  overhead, port limits, Docker socket dependency) motivated this decision
  and remains valid.
- **Build time.** Rust compilation is slower than Go. CI caching
  (`sccache`, cargo registry caching) is essential. Incremental builds
  during development are fast after the first compile.

## Risks

- **Tailscale protocol undocumented details.** The control protocol is not
  a public specification. Headscale reverse-engineered it. We will need to
  do the same, guided by Headscale's Go source and Wireshark captures. The
  protocol has been stable enough for Headscale to track for 4+ years.
- **NAT traversal complexity.** Tailscale's NAT traversal logic (ICE-like
  with proprietary extensions) is sophisticated. Phase 1 can defer hard NAT
  cases by relying on DERP relays for connectivity, adding direct
  connections incrementally.
- **Scope creep.** The phased approach exists to prevent this. Phase 1 is
  a coordinator that does exactly what Headscale does, nothing more. Novel
  features come in later phases.
