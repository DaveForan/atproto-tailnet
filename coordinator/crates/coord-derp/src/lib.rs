//! DERP relay and STUN servers for the coordinator stack (ADR-0027).
//!
//! DERP relays WireGuard packets between nodes that cannot reach each other
//! directly. Packets are addressed by node public key and stay end-to-end
//! encrypted; the relay never sees plaintext. The wire protocol matches what
//! stock Tailscale clients speak (protocol version 2). Mesh frames between
//! relays are not implemented.
//!
//! Unlike an open relay, [`DerpServer`] only serves nodes its [`Admission`]
//! policy admits, and only relays between nodes whose [`Scope`]s can reach
//! each other.

pub mod frame;
pub mod server;
pub mod stun;

pub use server::{Admission, AllowAll, DerpConfig, DerpError, DerpServer, LocalClient, Scope};
