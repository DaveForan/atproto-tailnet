//! Federation broker — Phase 3
//!
//! Ports the TypeScript federation system (CFP protocol, session lifecycle,
//! route engine, abuse protection, scoping) into the Rust coordinator.

pub mod abuse;
pub mod protocol;
pub mod route_engine;
pub mod scoping;
pub mod session;

// Re-export key types for convenience.
pub use abuse::{RateLimiter, ReplayGuard};
pub use protocol::{
    CfpMessage, Capability, FederationDescriptor, FederationType, HandshakePhase,
    KeepaliveMessage, RevokeMessage, RouteAnnouncement, RouteUpdate,
};
pub use route_engine::{InstalledRoute, RouteTable};
pub use scoping::{FederationScope, ScopedRoute};
pub use session::{FederationSession, SessionStatus};
