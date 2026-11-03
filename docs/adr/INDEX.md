# ADR Index — atproto-tailnet

Track ADRs like stories on a board. Each ADR moves through a lifecycle:

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
| 0013 | Multi-tenant Headscale fork | 2026-11-03 | — | 0001, 0009 |
| 0014 | Federation protocol specification | 2026-11-03 | — | 0010, 0011 |
| 0015 | Global / regional / local federation scoping | 2026-11-03 | — | 0014 |

### In Progress

(empty)

### Accepted

(empty)

### Proposed

(empty)

### Superseded

(empty)

### Deprecated

(empty)

## Lifecycle rules

- **Proposed**: Draft written, open for discussion
- **Accepted**: Decision made, ready for implementation
- **In Progress**: Active development underway
- **Implemented**: Code shipped, feature complete
- **Superseded**: Replaced by a newer ADR (link the replacement)
- **Deprecated**: No longer relevant, no replacement needed

## Conventions

- IDs are zero-padded 4-digit sequential numbers
- Every ADR frontmatter must include: Status, Date, Priority, Depends On
- When an ADR moves to Superseded, add `Superseded By: ADR-XXXX` to its frontmatter
- Dependencies form a DAG — never circular
