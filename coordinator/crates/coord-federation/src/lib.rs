//! Federation broker — Phase 3
//!
//! Ports the TypeScript federation system (CFP protocol, session lifecycle,
//! route engine, abuse protection, scoping, handshake, auth, transport,
//! discovery) into the Rust coordinator.

// Tier 1: core types and logic
pub mod abuse;
pub mod protocol;
pub mod route_engine;
pub mod scoping;
pub mod session;

// Tier 2: I/O adapters and handshake state machine
pub mod auth;
pub mod discovery;
pub mod handshake;
pub mod transport;

// Tier 3: broker orchestration, federation store, inbound handlers
pub mod broker;
pub mod federation_store_memory;
pub mod inbound;
pub mod pg_store;
pub mod sqlite_store;
pub mod store;

// Re-export types used by coord-api and coord-server.
pub use broker::{BrokerConfig, BrokerService};
pub use federation_store_memory::FederationMemoryStore;
pub use handshake::HandshakeCallbacks;
pub use inbound::{InboundError, InboundHandler};
pub use pg_store::PgFederationStore;
pub use sqlite_store::SqliteFederationStore;
pub use store::FederationStore;
