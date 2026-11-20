//! Gateway node (ADR-0029): a server-side member of tailnets, built from
//! primitive crates only. No Tailscale code.

pub mod netstack;

pub mod tunnel;
pub mod proxy;
