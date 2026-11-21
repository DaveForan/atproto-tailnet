use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};

use coord_core::TenantId;

/// The gateway node of each tenant that has one (ADR-0029), cached from tenant configuration.
#[derive(Default)]
pub struct GatewayRegistry {
    tenants: RwLock<HashMap<TenantId, i64>>,
    /// HTTPS service names are `<name>.<service_domain>` (ADR-0038). Unset: `<name>.<base_domain>`.
    service_domain: OnceLock<String>,
}

impl GatewayRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(&self, tenant: TenantId, node_id: i64) {
        self.tenants.write().unwrap_or_else(|e| e.into_inner()).insert(tenant, node_id);
    }

    pub fn get(&self, tenant: TenantId) -> Option<i64> {
        self.tenants.read().unwrap_or_else(|e| e.into_inner()).get(&tenant).copied()
    }

    pub fn remove(&self, tenant: TenantId) {
        self.tenants.write().unwrap_or_else(|e| e.into_inner()).remove(&tenant);
    }

    /// Sets the service domain once. Returns false when it was already set.
    pub fn set_service_domain(&self, domain: String) -> bool {
        self.service_domain.set(domain).is_ok()
    }

    pub fn service_domain(&self) -> Option<&str> {
        self.service_domain.get().map(String::as_str)
    }
}
