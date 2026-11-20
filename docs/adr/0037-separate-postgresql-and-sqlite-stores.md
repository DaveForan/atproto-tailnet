# ADR-0037: Keep separate PostgreSQL and SQLite store implementations

**Status:** Accepted
**Date:** 2026-11-20
**Priority:** P3
**Depends On:** ADR-0023 (Rust mesh coordinator), ADR-0034 (high availability)

## Context

The coordinator supports three store backends: memory, PostgreSQL and SQLite
(`coordinator/crates/coord-store`). The operator chooses one with
`COORD_STORE_BACKEND`.

A code evaluation (2026-11-20) found that `pg.rs` and `sqlite.rs` share about
70% of their lines after normalisation. `dispatch.rs` has about 178 match arms
that only forward each call to the selected backend. The evaluation suggested a
merge.

The two databases differ in ways that matter:

- Concurrency: PostgreSQL uses advisory transaction locks. SQLite uses
  `BEGIN IMMEDIATE`.
- Replicas: PostgreSQL carries events between replicas with LISTEN/NOTIFY
  (ADR-0034). SQLite serves one process only.
- Migrations: PostgreSQL can hash data in SQL (for example the pre-auth key
  hash). SQLite has no SHA-256, so the store does it in Rust at start-up.
- Types and syntax: UUID, JSON, timestamps, `RETURNING` and conflict handling
  differ.

## Decision

1. Keep one implementation for each backend. Do not merge them into one
   implementation and do not generate them from shared SQL.
2. Treat the similar lines as acceptable duplication. Each backend can follow
   its own database closely.
3. The backend-parity tests (`coordinator/crates/coord-store/tests/backend_parity.rs`)
   are the guard against drift. They run the same scenarios against memory,
   SQLite and PostgreSQL. CI runs them against a real PostgreSQL service and
   fails if `TEST_DATABASE_URL` is missing.
4. Every new store method must be added to all three backends and to the
   parity tests in the same change.

## Consequences

- A change to store behaviour touches three files. This is the cost of the
  decision.
- Each backend stays readable and can use the features of its database.
- Code reviews and evaluations must not report the PostgreSQL/SQLite similarity
  as a defect.

## Deferred option

Replace the `Store` enum and `dispatch.rs` with a `Store` trait (the same
pattern as `FederationStore`). This removes the forwarding boilerplate and does
not change the backend code. The value is small. Do it only together with other
work on `coord-store`.
