use thiserror::Error;

use crate::types::TenantId;

#[derive(Error, Debug)]
pub enum CoordError {
    #[error("tenant not found: {0}")]
    TenantNotFound(TenantId),

    #[error("CGNAT address space exhausted (100.64.0.0/10)")]
    AddressSpaceExhausted,

    #[error("protocol error: {0}")]
    Protocol(String),

    #[error("storage error: {0}")]
    Storage(#[from] sqlx::Error),

    #[error("internal error: {0}")]
    Internal(#[from] anyhow::Error),
}
