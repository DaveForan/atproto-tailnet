use thiserror::Error;

use crate::types::{NodeId, TenantId};

#[derive(Error, Debug)]
pub enum CoordError {
    #[error("tenant not found: {0}")]
    TenantNotFound(TenantId),

    #[error("node not found: {0}")]
    NodeNotFound(NodeId),

    #[error("invalid pre-auth key")]
    InvalidPreAuthKey,

    #[error("machine key already registered for tenant {0}")]
    DuplicateMachineKey(TenantId),

    #[error("CGNAT address space exhausted (100.64.0.0/10)")]
    AddressSpaceExhausted,

    #[error("noise handshake failed: {0}")]
    NoiseHandshake(String),

    #[error("protocol error: {0}")]
    Protocol(String),

    #[error("storage error: {0}")]
    Storage(#[from] sqlx::Error),

    #[error("internal error: {0}")]
    Internal(#[from] anyhow::Error),
}
