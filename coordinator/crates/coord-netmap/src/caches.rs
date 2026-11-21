//! Per-tenant configuration caches. The store holds the configuration (ADR-0034).

use std::collections::HashMap;
use std::sync::Arc;

use coord_acl::{AclPolicy, PolicyEngine};
use coord_core::TenantId;
use coord_proto::map::DerpMap;
use coord_store::Store;
use serde_json::Value;

use crate::{
    AutoApproverRegistry, AutoApprovers, DerpRegistry, GatewayRegistry, IdentityRegistry, NetmapService, TenantDerp,
    TenantIdentity,
};

/// Kinds of per-tenant configuration kept in the store (`coord_tenant_config`).
pub const CONFIG_ACL: &str = "acl";
pub const CONFIG_DERP: &str = "derp";
pub const CONFIG_AUTO_APPROVERS: &str = "auto_approvers";
pub const CONFIG_IDENTITY: &str = "identity";
/// The gateway node of the tenant: `{ "node_id": … }`.
pub const CONFIG_GATEWAY: &str = "gateway";

/// The registries that cache per-tenant configuration.
#[derive(Clone)]
pub struct TenantCaches {
    pub acl: Arc<PolicyEngine>,
    pub derp: Arc<DerpRegistry>,
    pub auto_approvers: Arc<AutoApproverRegistry>,
    pub identity: Arc<IdentityRegistry>,
    pub gateways: Arc<GatewayRegistry>,
}

impl TenantCaches {
    pub fn new(default_derp: DerpMap) -> Self {
        Self {
            acl: Arc::new(PolicyEngine::new()),
            derp: Arc::new(DerpRegistry::new(default_derp)),
            auto_approvers: Arc::new(AutoApproverRegistry::new()),
            identity: Arc::new(IdentityRegistry::new()),
            gateways: Arc::new(GatewayRegistry::new()),
        }
    }

    /// A netmap service that reads these caches.
    pub fn netmap(&self, store: Arc<Store>) -> NetmapService {
        NetmapService::with_identity(store, self.acl.clone(), self.derp.clone(), self.identity.clone())
            .with_gateways(self.gateways.clone())
    }

    /// Drop every cached value of a tenant.
    pub fn forget(&self, tenant: TenantId) {
        self.acl.remove_policy(tenant);
        self.derp.remove_tenant(tenant);
        self.auto_approvers.remove_tenant(tenant);
        self.identity.remove_tenant(tenant);
        self.gateways.remove(tenant);
    }

    /// Make the cached configuration of one tenant equal `stored`.
    ///
    /// Every value is parsed first. Then each entry is set or removed in one step,
    /// so a concurrent netmap sees the old or the new entry, never a gap.
    /// A value that cannot be read keeps the cached entry. Unknown kinds are ignored.
    pub fn replace(&self, tenant: TenantId, stored: Vec<(String, Value)>) {
        let mut by_kind: HashMap<String, Value> = stored.into_iter().collect();
        let acl = parse::<AclPolicy>(tenant, CONFIG_ACL, by_kind.remove(CONFIG_ACL));
        let derp = parse::<TenantDerp>(tenant, CONFIG_DERP, by_kind.remove(CONFIG_DERP));
        let approvers = parse::<AutoApprovers>(tenant, CONFIG_AUTO_APPROVERS, by_kind.remove(CONFIG_AUTO_APPROVERS));
        let identity = parse::<TenantIdentity>(tenant, CONFIG_IDENTITY, by_kind.remove(CONFIG_IDENTITY));
        let gateway = match by_kind.remove(CONFIG_GATEWAY) {
            None => Some(None),
            Some(v) => match v.get("node_id").and_then(Value::as_i64) {
                Some(n) => Some(Some(n)),
                None => {
                    unreadable(tenant, CONFIG_GATEWAY, "node_id is missing");
                    None
                }
            },
        };
        match acl {
            Some(Some(v)) => self.acl.set_policy(tenant, v),
            Some(None) => self.acl.remove_policy(tenant),
            None => {}
        }
        match derp {
            Some(Some(v)) => self.derp.set_tenant(tenant, v),
            Some(None) => self.derp.remove_tenant(tenant),
            None => {}
        }
        match approvers {
            Some(Some(v)) => self.auto_approvers.set_tenant(tenant, v),
            Some(None) => self.auto_approvers.remove_tenant(tenant),
            None => {}
        }
        match identity {
            Some(Some(v)) => self.identity.set_tenant(tenant, v),
            Some(None) => self.identity.remove_tenant(tenant),
            None => {}
        }
        match gateway {
            Some(Some(n)) => self.gateways.set(tenant, n),
            Some(None) => self.gateways.remove(tenant),
            None => {}
        }
    }
}

/// `Some(None)`: not stored. `Some(Some(_))`: stored and read. `None`: stored but unreadable.
fn parse<T: serde::de::DeserializeOwned>(tenant: TenantId, kind: &str, v: Option<Value>) -> Option<Option<T>> {
    match v.map(serde_json::from_value::<T>) {
        None => Some(None),
        Some(Ok(t)) => Some(Some(t)),
        Some(Err(e)) => {
            unreadable(tenant, kind, &e.to_string());
            None
        }
    }
}

fn unreadable(tenant: TenantId, kind: &str, error: &str) {
    tracing::warn!(tenant = %tenant, kind, error, "stored tenant configuration could not be read; keeping the cached value");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caches() -> TenantCaches {
        TenantCaches::new(DerpMap { regions: HashMap::new(), omit_default_regions: Some(true) })
    }

    #[test]
    fn replace_sets_and_clears_each_kind() {
        let c = caches();
        let t = TenantId::generate();
        c.replace(
            t,
            vec![
                (CONFIG_ACL.into(), serde_json::json!({ "default_deny": true })),
                (CONFIG_GATEWAY.into(), serde_json::json!({ "node_id": 7 })),
                ("from_a_newer_version".into(), serde_json::json!(1)),
            ],
        );
        assert!(c.acl.get_policy(t).is_some_and(|p| p.default_deny));
        assert_eq!(c.gateways.get(t), Some(7));
        c.replace(t, vec![]);
        assert!(c.acl.get_policy(t).is_none());
        assert_eq!(c.gateways.get(t), None);
    }

    #[test]
    fn an_unreadable_value_keeps_the_cached_entry() {
        let c = caches();
        let t = TenantId::generate();
        c.replace(t, vec![(CONFIG_GATEWAY.into(), serde_json::json!({ "node_id": 7 }))]);
        c.replace(t, vec![(CONFIG_GATEWAY.into(), serde_json::json!({ "node": "x" }))]);
        assert_eq!(c.gateways.get(t), Some(7));
        c.forget(t);
        assert_eq!(c.gateways.get(t), None);
    }
}
