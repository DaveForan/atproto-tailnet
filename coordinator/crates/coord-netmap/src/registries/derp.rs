use std::collections::HashMap;
use std::sync::RwLock;

use coord_core::TenantId;
use coord_proto::map::{DerpMap, DerpRegion};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TenantDerp {
    pub custom_regions: HashMap<i32, DerpRegion>,
    pub include_default: bool,
}

/// Operator-wide default DERP map plus per-tenant overrides.
///
/// The default map is the configured base map plus one region for each live
/// relay process that control replicas discover in the store (ADR-0034).
pub struct DerpRegistry {
    base: DerpMap,
    default: RwLock<DerpMap>,
    tenants: RwLock<HashMap<TenantId, TenantDerp>>,
}

impl DerpRegistry {
    pub fn new(default: DerpMap) -> Self {
        Self { base: default.clone(), default: RwLock::new(default), tenants: RwLock::new(HashMap::new()) }
    }

    pub fn default_map(&self) -> DerpMap {
        self.default.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Set the regions of the discovered relays. A discovered region replaces
    /// a base region with the same id. Returns true when the default map changed.
    pub fn set_relay_regions(&self, regions: Vec<DerpRegion>) -> bool {
        let mut next = self.base.clone();
        for region in regions {
            next.regions.insert(region.region_id, region);
        }
        let mut current = self.default.write().unwrap_or_else(|e| e.into_inner());
        let same = serde_json::to_value(&*current).ok() == serde_json::to_value(&next).ok();
        *current = next;
        !same
    }

    pub fn set_tenant(&self, tenant: TenantId, cfg: TenantDerp) {
        self.tenants.write().unwrap_or_else(|e| e.into_inner()).insert(tenant, cfg);
    }

    pub fn get_tenant(&self, tenant: TenantId) -> Option<TenantDerp> {
        self.tenants.read().unwrap_or_else(|e| e.into_inner()).get(&tenant).cloned()
    }

    pub fn remove_tenant(&self, tenant: TenantId) {
        self.tenants.write().unwrap_or_else(|e| e.into_inner()).remove(&tenant);
    }

    pub fn map_for(&self, tenant: TenantId) -> DerpMap {
        let default = self.default_map();
        let Some(cfg) = self.get_tenant(tenant) else {
            return default;
        };
        let mut regions = if cfg.include_default {
            default.regions
        } else {
            HashMap::new()
        };
        regions.extend(cfg.custom_regions);
        DerpMap { regions, omit_default_regions: Some(true) }
    }
}
