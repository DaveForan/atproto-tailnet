//! Federation broker for the Collective Federation Protocol (CFP).

pub mod abuse;
pub mod protocol;
pub mod route_engine;
pub mod scoping;
pub mod session;

pub mod auth;
pub mod discovery;
pub mod handshake;
pub mod transport;

// RFC 8785 canonicalization and detached-JWS Ed25519, byte-compatible with the TS service.
pub mod canonical;
pub mod signing;

pub mod broker;
pub mod federation_store_memory;
pub mod inbound;
pub mod pg_store;
pub mod sqlite_store;
pub mod store;

pub use broker::{BrokerConfig, BrokerService};
pub use federation_store_memory::FederationMemoryStore;
pub use handshake::HandshakeCallbacks;
pub use inbound::{InboundError, InboundHandler};
pub use pg_store::PgFederationStore;
pub use sqlite_store::SqliteFederationStore;
pub use store::FederationStore;

#[cfg(test)]
mod cfp_vectors;
