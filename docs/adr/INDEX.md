# ADR Index — atproto-tailnet

Track ADRs like stories on a board. Each ADR moves through these lifecycle states:

**Proposed** → **Accepted** → **In Progress** → **Implemented** → **Superseded** / **Deprecated**

## Board

### Implemented

| ID | Title | Date | Supersedes | Depends On |
|----|-------|------|------------|------------|
| 0001 | Use Headscale as the Tailscale control plane | 2026-10-23 | — | — |
| 0002 | Multi-tenancy via orchestrated Headscale instances | 2026-10-23 | — | 0001 |
| 0003 | AT Protocol OAuth for user authentication | 2026-10-23 | — | — |
| 0004 | Service architecture and technology choices | 2026-10-23 | — | 0001, 0002, 0003 |
| 0005 | Tenant security management — composable role system | 2026-10-23 | — | 0004 |
| 0006 | Custom DERP relay and IP range configuration | 2026-11-02 | — | 0001, 0002 |
| 0007 | Usage metering, plan limits, and federation | 2026-11-02 | — | 0002 |
| 0008 | Exit node and subnet router management | 2026-11-02 | — | 0001, 0002 |
| 0009 | Hierarchical tenancy model | 2026-11-03 | — | 0002 |
| 0010 | Federation control plane | 2026-11-03 | — | 0009 |
| 0011 | Traversal policy engine | 2026-11-03 | — | 0010 |
| 0012 | AT Proto identity as network passport | 2026-11-03 | — | 0003, 0009 |
| 0014 | Federation protocol specification | 2026-11-03 | — | 0010, 0011 |
| 0015 | Global / regional / local federation scoping | 2026-11-03 | — | 0014 |
| 0016 | Federation transport and broker integration | 2026-11-04 | — | 0010, 0014 |
| 0017 | DID resolution and identity verification | 2026-11-04 | — | 0003, 0012 |
| 0018 | Dashboard completeness and correctness | 2026-11-04 | — | 0016, 0017 |
| 0019 | Cross-instance federation links | 2026-11-04 | — | 0014, 0016, 0017 |
| 0020 | Federation relay data plane | 2026-11-04 | — | 0006, 0010, 0016, 0019 |
| 0021 | Holder binding for AT Proto accounts | 2026-11-04 | — | 0003, 0012, 0017 |

### In Progress

| ID | Title | Date | Supersedes | Depends On |
|----|-------|------|------------|------------|
| 0023 | Rust mesh coordinator | 2026-11-06 | 0001, 0002, 0013 | 0009, 0010 |

### Accepted

(empty)

### Proposed

| ID | Title | Date | Supersedes | Depends On |
|----|-------|------|------------|------------|
| 0022 | Tenant TLS for any DNS provider | 2026-11-05 | — | 0002, 0004 |
| 0024 | Purpose-built mesh client | 2026-11-06 | — | 0023 |

### Superseded

| ID | Title | Date | Superseded By |
|----|-------|------|---------------|
| 0013 | Multi-tenant Headscale fork | 2026-11-03 | 0023 |

### Deprecated

(empty)

## Lifecycle rules

- **Proposed**: The draft is complete. The team can discuss it.
- **Accepted**: The team made the decision. The ADR is ready for implementation.
- **In Progress**: Development is in progress.
- **Implemented**: The code is in production and the feature is complete.
- **Superseded**: A newer ADR replaces this ADR. Link to the new ADR.
- **Deprecated**: The ADR is no longer relevant. No new ADR replaces it.

## Conventions

- An ID is a sequential number with 4 digits and leading zeros.
- The frontmatter of each ADR must include these fields: Status, Date, Priority, Depends On.
- When an ADR moves to Superseded, add `Superseded By: ADR-XXXX` to its frontmatter.
- Dependencies form a DAG. Do not create circular dependencies.
