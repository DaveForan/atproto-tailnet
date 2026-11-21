//! DERP relay and STUN servers (ADR-0027), wire-compatible with Tailscale DERP protocol v2.
//! The relay forwards end-to-end encrypted WireGuard packets by node key. It has no mesh frames.
//! [`DerpServer`] serves only nodes that [`Admission`] admits, between [`Scope`]s that can reach each other.

pub mod frame;
pub mod server;
pub mod stun;

pub use server::{Admission, AllowAll, DerpConfig, DerpError, DerpServer, LocalClient, Scope};
