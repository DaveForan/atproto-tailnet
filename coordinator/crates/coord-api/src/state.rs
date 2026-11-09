use std::sync::Arc;
use coord_core::ControlKey;
use coord_acl::PolicyEngine;
use coord_federation::{
    BrokerConfig, BrokerService, FederationMemoryStore, InboundHandler,
};
use coord_proto::map::DerpMap;
use coord_store::{MemoryStore, Store};

pub struct CoordinatorState {
    pub control_key: ControlKey,
    pub store: Arc<Store>,
    pub acl: Arc<PolicyEngine>,
    pub derp_map: DerpMap,
    pub admin_api_key: Option<String>,
    pub federation_inbound: Arc<InboundHandler<FederationMemoryStore>>,
    pub federation_broker: Arc<BrokerService<FederationMemoryStore>>,
}

impl CoordinatorState {
    pub fn new(control_key: ControlKey) -> Self {
        let fed_store = Arc::new(FederationMemoryStore::new());
        let fed_config = BrokerConfig::default();
        Self {
            control_key,
            store: Arc::new(Store::Memory(MemoryStore::new())),
            acl: Arc::new(PolicyEngine::new()),
            derp_map: default_derp_map(),
            admin_api_key: None,
            federation_inbound: Arc::new(InboundHandler::new(
                fed_store.clone(),
                fed_config.clone(),
            )),
            federation_broker: Arc::new(BrokerService::new(fed_store, fed_config)),
        }
    }

    pub fn with_store(mut self, store: Store) -> Self {
        self.store = Arc::new(store);
        self
    }

    pub fn with_derp_map(mut self, derp_map: DerpMap) -> Self {
        self.derp_map = derp_map;
        self
    }

    pub fn with_admin_api_key(mut self, key: Option<String>) -> Self {
        self.admin_api_key = key;
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
