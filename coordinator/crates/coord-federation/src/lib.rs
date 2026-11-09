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
pub mod store;

// Re-export key types for convenience.
pub use abuse::{RateLimiter, ReplayGuard};
pub use auth::{PublicKeyResolver, SignFn};
pub use broker::{BrokerConfig, BrokerService};
pub use discovery::PeerInfo;
pub use federation_store_memory::FederationMemoryStore;
pub use pg_store::PgFederationStore;
pub use handshake::{HandshakeCallbacks, HandshakeState};
pub use inbound::{InboundError, InboundHandler};
pub use protocol::{
    CfpMessage, Capability, FederationDescriptor, FederationType, HandshakePhase,
    KeepaliveMessage, RevokeMessage, RouteAnnouncement, RouteUpdate,
};
pub use route_engine::{InstalledRoute, RouteTable};
pub use scoping::{FederationScope, ScopedRoute};
pub use session::{FederationSession, SessionStatus};
pub use store::FederationStore;
pub use transport::SendResult;
