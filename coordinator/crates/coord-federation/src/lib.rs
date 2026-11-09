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

// Re-export key types for convenience.
pub use abuse::{RateLimiter, ReplayGuard};
pub use auth::{PublicKeyResolver, SignFn};
pub use discovery::PeerInfo;
pub use handshake::{HandshakeCallbacks, HandshakeState};
pub use protocol::{
    CfpMessage, Capability, FederationDescriptor, FederationType, HandshakePhase,
    KeepaliveMessage, RevokeMessage, RouteAnnouncement, RouteUpdate,
};
pub use route_engine::{InstalledRoute, RouteTable};
pub use scoping::{FederationScope, ScopedRoute};
pub use session::{FederationSession, SessionStatus};
pub use transport::SendResult;
