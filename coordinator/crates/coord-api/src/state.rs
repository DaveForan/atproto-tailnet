use std::sync::Arc;
use coord_core::ControlKey;
use coord_acl::PolicyEngine;
use coord_proto::map::DerpMap;
use coord_store::MemoryStore;

pub struct CoordinatorState {
    pub control_key: ControlKey,
    pub store: Arc<MemoryStore>,
    pub acl: Arc<PolicyEngine>,
    pub derp_map: DerpMap,
}

impl CoordinatorState {
    pub fn new(control_key: ControlKey) -> Self {
        Self {
            control_key,
            store: Arc::new(MemoryStore::new()),
            acl: Arc::new(PolicyEngine::new()),
            derp_map: default_derp_map(),
        }
    }

    pub fn with_derp_map(mut self, derp_map: DerpMap) -> Self {
        self.derp_map = derp_map;
        self
    }
}

fn default_derp_map() -> DerpMap {
    use coord_proto::map::{DerpRegion, DerpNode};
    let mut regions = std::collections::HashMap::new();
    regions.insert(
        1,
        DerpRegion {
            region_id: 1,
            region_code: "default".into(),
            region_name: "Default".into(),
            nodes: vec![DerpNode {
                name: "1a".into(),
                region_id: 1,
                host_name: "derp1.tailscale.com".into(),
                cert_name: None,
                ipv4: None,
                ipv6: None,
                stun_port: 3478,
                derp_port: 443,
                stun_only: None,
                insecure_for_tests: None,
            }],
        },
    );
    DerpMap {
        regions,
        omit_default_regions: Some(true),
    }
}
