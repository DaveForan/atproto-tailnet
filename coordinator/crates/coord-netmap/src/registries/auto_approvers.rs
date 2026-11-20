use std::collections::HashMap;
use std::sync::RwLock;

use coord_core::routes::Cidr;
use coord_core::TenantId;

/// Per-tenant route auto-approval policy (in-memory; the TS service replays it).
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AutoApprovers {
    /// CIDR -> tags whose nodes get advertised routes inside that CIDR approved.
    #[serde(default)]
    pub routes: std::collections::BTreeMap<String, Vec<String>>,
    /// Tags whose nodes get exit routes (0.0.0.0/0, ::/0) approved.
    #[serde(default)]
    pub exit_node: Vec<String>,
}

impl AutoApprovers {
    /// The subset of `advertised` that a node carrying `tags` gets approved automatically.
    /// Untagged nodes never match. Exit routes are only approved via `exit_node`.
    pub fn approvable(&self, tags: &[String], advertised: &[String]) -> Vec<String> {
        if tags.is_empty() {
            return vec![];
        }
        let has_tag = |allowed: &[String]| allowed.iter().any(|t| tags.contains(t));
        let rules: Vec<(Cidr, &Vec<String>)> = self
            .routes
            .iter()
            .filter_map(|(cidr, tags)| Some((Cidr::parse(cidr)?, tags)))
            .collect();
        advertised
            .iter()
            .filter(|r| {
                let Some(route) = Cidr::parse(r) else { return false };
                if route.is_exit() {
                    return has_tag(&self.exit_node);
                }
                rules.iter().any(|(outer, allowed)| outer.contains(&route) && has_tag(allowed))
            })
            .cloned()
            .collect()
    }
}

#[derive(Default)]
pub struct AutoApproverRegistry {
    tenants: RwLock<HashMap<TenantId, AutoApprovers>>,
}

impl AutoApproverRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_tenant(&self, tenant: TenantId, cfg: AutoApprovers) {
        self.tenants.write().unwrap_or_else(|e| e.into_inner()).insert(tenant, cfg);
    }

    pub fn get_tenant(&self, tenant: TenantId) -> AutoApprovers {
        self.tenants
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(&tenant)
            .cloned()
            .unwrap_or_default()
    }

    pub fn remove_tenant(&self, tenant: TenantId) {
        self.tenants.write().unwrap_or_else(|e| e.into_inner()).remove(&tenant);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn auto_approver_containment_and_tags() {
        let mut aa = AutoApprovers::default();
        aa.routes.insert("10.0.0.0/8".into(), s(&["tag:relay"]));
        aa.exit_node = s(&["tag:exit"]);
        let adv = s(&["10.1.0.0/16", "192.168.0.0/24", "0.0.0.0/0"]);
        assert_eq!(aa.approvable(&s(&["tag:relay"]), &adv), s(&["10.1.0.0/16"]));
        assert_eq!(aa.approvable(&s(&["tag:exit"]), &adv), s(&["0.0.0.0/0"]));
        assert!(aa.approvable(&[], &adv).is_empty());
        assert!(aa.approvable(&s(&["tag:other"]), &adv).is_empty());
    }
}
