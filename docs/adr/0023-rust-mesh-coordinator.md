# ADR-0023: Rust mesh coordinator

**Status:** Accepted
**Date:** 2026-11-06
**Priority:** P0
**Depends On:** ADR-0009 (hierarchical tenancy), ADR-0010 (federation control plane)
**Supersedes:** ADR-0001 (Headscale as control plane), ADR-0002 (container-per-tenant), ADR-0013 (Go fork)

## Context

ADR-0013 proposed a Headscale fork in Go to add multi-tenant namespace
separation. That approach keeps access to the Go libraries of Tailscale. But it
inherits the limits of the Go type system and the single-tenant architecture of
Headscale. Convention and testing must enforce every multi-tenant invariant.
The compiler cannot enforce any of them. ADR-0013 explicitly noted this as an
accepted tradeoff.

We revisited that tradeoff. The project is not Tailscale. It is a hierarchical
federated mesh network with AT Proto identity, credential-gated traversal, and
per-hop policy enforcement. Every layer that we inherit from Tailscale and
Headscale fights the architecture that this project needs. These layers are the
single-coordinator assumption, the flat namespace model, the account-based
auth, and the monolithic netmap.

The underlying protocol layers are well-specified. They have production Rust
implementations:

- **WireGuard**: `boringtun` (Cloudflare, production-grade userspace
  implementation), plus the kernel module for the Linux data plane
- **Noise IK**: the `snow` crate (Noise protocol framework, audited)
- **DERP relay**: a simple HTTP upgrade and binary framing protocol. It needs
  approximately 500 lines to implement
- **STUN/NAT traversal**: the `stun-rs` and `webrtc-rs` crates

Headscale provides coordination logic on top of these primitives. This logic
covers netmap generation, node registration, key management, ACL evaluation,
and the HTTP/Noise transport that Tailscale clients speak. We must redesign
exactly this coordination logic for multi-tenancy, federation, and hierarchical
namespaces. If we fork Headscale, we rewrite the logic anyway, but inside the
architecture of someone else.

### Why Rust

- **Type-level tenant isolation.** A `TenantId` newtype runs through every
  query, every netmap build, and every ACL evaluation. The compiler catches
  cross-tenant leaks. Go relies on `WHERE` clauses and code review to prevent
  them.
- **Enum-driven protocol states.** Noise handshake states, federation link
  states, and traversal credential verification are all exhaustive enums.
  Invalid state transitions are compilation errors.
- **Memory safety without GC.** A long-running coordinator that serves
  thousands of tenants needs predictable latency. Rust has no GC pauses and no
  goroutine leaks.
- **Trait-based abstraction.** The subsystems of the coordinator (node
  registry, netmap builder, ACL engine, federation broker) compose through
  traits, not interface pollution. They are generic over the storage backend
  for testing.
- **Single binary deployment.** No Docker socket, no container-per-tenant, and
  no port pool. One process, one binary, one PostgreSQL connection pool.

## Decision

We built a purpose-built mesh coordinator in Rust. In Phase 1, we maintain
Tailscale client wire compatibility, so the existing `tailscale` CLI works
immediately. We diverge the protocol as the client evolves (ADR-0024).

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

The Tailscale client connects to its coordinator over HTTPS. It upgrades the
connection to a Noise IK session. The coordinator must implement these items:

1. **`/ts2021` upgrade endpoint** — an HTTP upgrade to the Noise IK transport.
   The client sends its machine key. The coordinator responds with the control
   key. The Noise session encrypts all later messages.

2. **Control messages over Noise** — The coordinator sends `MapResponse` (the
   netmap: peer list, DERP map, DNS config, ACL rules). It receives
   `MapRequest` (node state updates, endpoint changes). These messages are
   protobuf-encoded or JSON-encoded Tailscale types.

3. **`/key?v=...` endpoint** — It returns the Noise public key of the
   coordinator, so clients can start the handshake.

4. **`/machine/register`** — Pre-auth key registration (legacy path, which some
   clients still use).

5. **DERP map serving** — The coordinator tells clients which DERP relays to
   use. It can point to external Tailscale DERP servers or to self-hosted
   servers.

6. **DNS configuration** — MagicDNS names for nodes in the namespace.

### Multi-tenant model

`TenantId` parameterizes every coordinator subsystem:

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

Cross-tenant access is impossible unless the type signatures explicitly carry
both tenant IDs (as in federation routing).

### Hierarchical namespaces

Sub-collectives are tenants whose `parent_id` references another tenant. The
netmap builder for a parent tenant can optionally include aggregated routes from
child tenants (subject to policy). This is in-process. It needs no
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

The federation broker (currently in TypeScript) moves into the coordinator as a
Rust module. Federation links, the CFP handshake, route exchange, and relay
provisioning are all coordinator-internal operations. They have direct access
to the netmap and the ACL engine. No HTTP round-trips occur between the
management service and the control plane.

### Project structure

The coordinator lives in the atproto-tailnet repository:

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
- Noise IK transport that accepts Tailscale client connections
- Node registration with pre-auth keys
- Single-tenant netmap generation
- REST API for node/key management
- `tailscale up --login-server` works against it

**Phase 2: Multi-tenant and hierarchy**
- TenantId-scoped everything
- Sub-collective namespace tree
- Per-tenant ACL engine
- REST API with tenant context
- The TypeScript service delegates to the coordinator instead of Headscale

**Phase 3: Federation native**
- Federation broker as a coordinator module
- Cross-tenant route advertisement
- Traversal credential verification at the coordinator level
- Integrated relay provisioning

**Phase 4: Protocol divergence**
- Custom control messages for credential presentation
- Namespace-aware DERP relay selection
- Leads into ADR-0024 (purpose-built client)

## Consequences

- **Headscale is removed.** We no longer need container-per-tenant
  orchestration, the Docker socket dependency, the port allocation pool, or
  per-container health monitoring. The TypeScript service manages the
  coordinator as a single subprocess or sidecar.
- **Tailscale client compatibility is temporary.** Phases 1-3 maintain it.
  Phase 4 begins the divergence. ADR-0024 covers the transition.
- **The TypeScript service remains.** It handles AT Proto OAuth, the web
  dashboard, credential issuance, and user management. The coordinator handles
  WireGuard coordination, netmap generation, and ACL enforcement. They
  communicate through the REST API and shared PostgreSQL.
- **New language in the project.** Rust joins TypeScript. The coordinator is a
  self-contained workspace with its own CI. The boundary is clean. TypeScript
  is the web layer and Rust is the network layer.
- **Migration from Headscale.** Existing deployments need a data migration from
  per-tenant SQLite databases to the shared PostgreSQL schema. The same concern
  existed in ADR-0013, and the solution is the same: iterate the SQLite files,
  transform with tenant_id, and preserve the WireGuard keys.
- **ADR-0013 is superseded.** A ground-up Rust implementation replaces the Go
  fork approach. The analysis in ADR-0013 (resource overhead, port limits,
  Docker socket dependency) motivated this decision and remains valid.
- **Build time.** Rust compiles more slowly than Go. CI caching (`sccache`,
  cargo registry caching) is essential. Incremental builds during development
  are fast after the first compile.

## Implementation progress

**Phase 1: Minimal compatible coordinator** — Complete
- 9 crates: coord-core, coord-noise, coord-proto, coord-netmap, coord-acl, coord-store, coord-api, coord-federation, coord-server
- Noise IK transport, node registration, pre-auth keys, netmap generation
- REST admin API (tenants, nodes, ACL, posture, preauth keys)
- MemoryStore + PgStore with sqlx migrations
- 36 Rust tests + Go interop verified

**Phase 2: Multi-tenant and hierarchy** — Complete
- TenantId-scoped stores with dispatch enum (Memory | Pg)
- Sub-collective parent/child hierarchy with posture-gated visibility
- Per-tenant ACL engine with FilterRule generation
- CoordinatorApiClient in TypeScript for seamless delegation
- Docker deployment stack (Dockerfile, compose, Caddyfiles)

**Phase 3: Federation native** — Complete
- coord-federation crate: 13 modules, 5,400+ lines, 83 tests
- Tier 1 (pure logic): protocol types, session lifecycle, BGP-like route engine, abuse controls, geographic scoping
- Tier 2 (I/O adapters): 4-phase CFP handshake state machine, message auth, HTTP transport, peer discovery with SSRF guard
- Tier 3 (orchestration): FederationStore trait, in-memory + PgStore implementations, BrokerService reconciliation loop, InboundHandler for all 8 CFP message types
- Axum federation message routes at `/api/federation/messages/{hello,commit,keepalive,revoke,link-request,link-accept,link-reject,link-revoke}`
- Background broker tick loop (30s interval) for session reconciliation, keepalive, and health checks
- Dynamic store dispatch: PgFederationStore used when DATABASE_URL set, FederationMemoryStore otherwise

**Phase 4: Protocol divergence** — Not started

## Risks

- **Tailscale protocol undocumented details.** The control protocol is not a
  public specification. Headscale reverse-engineered it. We must do the same,
  guided by the Go source of Headscale and Wireshark captures. The protocol has
  been stable enough for Headscale to track for 4+ years.
- **NAT traversal complexity.** The NAT traversal logic of Tailscale (ICE-like
  with proprietary extensions) is sophisticated. Phase 1 can defer hard NAT
  cases because it relies on DERP relays for connectivity. We add direct
  connections incrementally.
- **Scope creep.** The phased approach exists to prevent this. Phase 1 is a
  coordinator that does exactly what Headscale does, and nothing more. Novel
  features come in later phases.
