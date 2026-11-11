use std::sync::Arc;
use coord_core::ControlKey;
use coord_acl::PolicyEngine;
use coord_federation::{
    BrokerConfig, BrokerService, FederationMemoryStore, FederationStore,
    HandshakeCallbacks, InboundHandler,
};
use coord_netmap::NetmapService;
use coord_proto::map::DerpMap;
use coord_store::{MemoryStore, Store};

pub struct CoordinatorState {
    pub(crate) control_key: ControlKey,
    pub(crate) store: Arc<Store>,
    pub(crate) acl: Arc<PolicyEngine>,
    pub(crate) derp_map: DerpMap,
    pub(crate) admin_api_key: Option<String>,
    pub(crate) netmap: NetmapService,
    pub(crate) federation_inbound: Arc<InboundHandler<dyn FederationStore>>,
    pub(crate) federation_broker: Arc<BrokerService<dyn FederationStore>>,
    pub(crate) federation_callbacks: Option<Arc<dyn HandshakeCallbacks>>,
}

impl CoordinatorState {
    pub fn new(control_key: ControlKey) -> Self {
        let fed_store: Arc<dyn FederationStore> = Arc::new(FederationMemoryStore::new());
        let fed_config = BrokerConfig::default();
        let store = Arc::new(Store::Memory(Box::new(MemoryStore::new())));
        let acl = Arc::new(PolicyEngine::new());
        let derp_map = default_derp_map();
        let netmap = NetmapService::new(store.clone(), acl.clone(), derp_map.clone());
        Self {
            control_key,
            store,
            acl,
            derp_map,
            admin_api_key: None,
            netmap,
            federation_inbound: Arc::new(InboundHandler::new(
                fed_store.clone(),
                fed_config.clone(),
            )),
            federation_broker: Arc::new(BrokerService::new(fed_store, fed_config)),
            federation_callbacks: None,
        }
    }

    pub fn with_federation_store(mut self, store: Arc<dyn FederationStore>) -> Self {
        let fed_config = self.federation_broker.config().clone();
        self.federation_inbound = Arc::new(InboundHandler::new(
            store.clone(),
            fed_config.clone(),
        ));
        self.federation_broker = Arc::new(BrokerService::new(store, fed_config));
        self
    }

    pub fn with_store(mut self, store: Store) -> Self {
        self.store = Arc::new(store);
        self.netmap = NetmapService::new(self.store.clone(), self.acl.clone(), self.derp_map.clone());
        self
    }

    pub fn with_derp_map(mut self, derp_map: DerpMap) -> Self {
        self.derp_map = derp_map;
        self.netmap = NetmapService::new(self.store.clone(), self.acl.clone(), self.derp_map.clone());
        self
    }

    pub fn with_admin_api_key(mut self, key: Option<String>) -> Self {
        self.admin_api_key = key;
        self
    }

    pub fn with_federation_callbacks(mut self, cb: Arc<dyn HandshakeCallbacks>) -> Self {
        self.federation_callbacks = Some(cb);
        self
    }

    pub fn control_key(&self) -> &ControlKey {
        &self.control_key
    }

    pub fn store(&self) -> &Arc<Store> {
        &self.store
    }

    pub fn acl(&self) -> &Arc<PolicyEngine> {
        &self.acl
    }

    pub fn federation_inbound(&self) -> &Arc<InboundHandler<dyn FederationStore>> {
        &self.federation_inbound
    }

    pub fn netmap(&self) -> &NetmapService {
        &self.netmap
    }

    pub fn federation_broker(&self) -> &Arc<BrokerService<dyn FederationStore>> {
        &self.federation_broker
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
