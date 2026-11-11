use std::fmt;

use crate::types::TenantId;

#[derive(Debug)]
pub struct StorageError(Box<dyn std::error::Error + Send + Sync>);

impl StorageError {
    pub fn new(e: impl std::error::Error + Send + Sync + 'static) -> Self {
        Self(Box::new(e))
    }
}

impl fmt::Display for StorageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for StorageError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&*self.0)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CoordError {
    #[error("tenant not found: {0}")]
    TenantNotFound(TenantId),

    #[error("CGNAT address space exhausted (100.64.0.0/10)")]
    AddressSpaceExhausted,

    #[error("protocol error: {0}")]
    Protocol(String),

    #[error("storage error: {0}")]
    Storage(#[from] StorageError),
}
