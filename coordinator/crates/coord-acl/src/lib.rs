mod policy;

use coord_core::{AclVerdict, NodeId, TenantId};

pub use policy::{AclPolicy, AclRule, PortSpec};

pub trait AclEngine: Send + Sync {
    fn evaluate(&self, tenant: TenantId, src: NodeId, dst: NodeId, port: u16) -> AclVerdict;
    fn filter_rules_for_node(&self, tenant: TenantId, node_id: NodeId, node_ip: &str)
        -> Vec<coord_proto::map::FilterRule>;
}

pub struct PolicyEngine {
    policies: std::sync::RwLock<std::collections::HashMap<TenantId, AclPolicy>>,
}

impl PolicyEngine {
    pub fn new() -> Self {
        Self {
            policies: std::sync::RwLock::new(std::collections::HashMap::new()),
        }
    }

    pub fn set_policy(&self, tenant: TenantId, policy: AclPolicy) {
        let mut policies = self.policies.write().unwrap();
        policies.insert(tenant, policy);
    }

    pub fn get_policy(&self, tenant: TenantId) -> Option<AclPolicy> {
        let policies = self.policies.read().unwrap();
        policies.get(&tenant).cloned()
    }
}

impl AclEngine for PolicyEngine {
    fn evaluate(&self, tenant: TenantId, _src: NodeId, _dst: NodeId, _port: u16) -> AclVerdict {
        let policies = self.policies.read().unwrap();
        match policies.get(&tenant) {
            Some(policy) if policy.default_deny => AclVerdict::Deny,
            _ => AclVerdict::Allow,
        }
    }

    fn filter_rules_for_node(
        &self,
        tenant: TenantId,
        _node_id: NodeId,
        _node_ip: &str,
    ) -> Vec<coord_proto::map::FilterRule> {
        let policies = self.policies.read().unwrap();
        match policies.get(&tenant) {
            Some(policy) => policy.to_filter_rules(),
            None => policy::allow_all_filter(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_allow_all() {
        let engine = PolicyEngine::new();
        let tid = TenantId::generate();
        let nid = NodeId::new(1);
        let rules = engine.filter_rules_for_node(tid, nid, "100.64.0.1");
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].src_ips[0], "*");
    }

    #[test]
    fn custom_policy() {
        let engine = PolicyEngine::new();
        let tid = TenantId::generate();

        let policy = AclPolicy {
            default_deny: false,
            rules: vec![
                AclRule {
                    src: "*".into(),
                    dst: "*".into(),
                    ports: vec![PortSpec::Single(22), PortSpec::Range(80, 443)],
                },
            ],
        };
        engine.set_policy(tid, policy);

        let nid = NodeId::new(1);
        let rules = engine.filter_rules_for_node(tid, nid, "100.64.0.1");
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].dst_ports.len(), 2);
        assert_eq!(rules[0].dst_ports[0].ports.first, 22);
        assert_eq!(rules[0].dst_ports[0].ports.last, 22);
        assert_eq!(rules[0].dst_ports[1].ports.first, 80);
        assert_eq!(rules[0].dst_ports[1].ports.last, 443);
    }

    #[test]
    fn default_deny_policy() {
        let engine = PolicyEngine::new();
        let tid = TenantId::generate();
        let nid = NodeId::new(1);

        let policy = AclPolicy {
            default_deny: true,
            rules: vec![],
        };
        engine.set_policy(tid, policy);

        let verdict = engine.evaluate(tid, nid, NodeId::new(2), 80);
        assert_eq!(verdict, AclVerdict::Deny);

        let rules = engine.filter_rules_for_node(tid, nid, "100.64.0.1");
        assert!(rules.is_empty());
    }
}
