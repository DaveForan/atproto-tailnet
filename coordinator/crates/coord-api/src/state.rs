use std::sync::Arc;
use tokio::sync::{broadcast, Semaphore};
use coord_core::{ControlKey, TenantId};
use coord_acl::PolicyEngine;
use coord_federation::{
    BrokerConfig, BrokerService, FederationMemoryStore, FederationStore,
    HandshakeCallbacks, InboundHandler,
};
use coord_netmap::{AutoApproverRegistry, DerpRegistry, NetmapService};
use coord_proto::map::DerpMap;
use coord_store::{MemoryStore, Store};

pub struct CoordinatorState {
    pub(crate) control_key: ControlKey,
    pub(crate) store: Arc<Store>,
    pub(crate) acl: Arc<PolicyEngine>,
    pub(crate) derp: Arc<DerpRegistry>,
    /// Per-tenant route auto-approvers (in-memory; TS service replays them).
    pub(crate) auto_approvers: Arc<AutoApproverRegistry>,
    pub(crate) admin_api_key: Option<String>,
    pub(crate) netmap: NetmapService,
    /// Fires when a tenant's ACL or DERP config changes so live map streams resend a snapshot.
    pub(crate) config_changed: broadcast::Sender<TenantId>,
    pub(crate) federation_inbound: Arc<InboundHandler<dyn FederationStore>>,
    pub(crate) federation_broker: Arc<BrokerService<dyn FederationStore>>,
    pub(crate) federation_callbacks: Option<Arc<dyn HandshakeCallbacks>>,
    pub(crate) federation_enabled: bool,
    /// Caps simultaneous Noise (ts2021) connections instance-wide. Behind Caddy
    /// every connection shares Caddy's source IP, so a per-IP cap isn't possible.
    pub(crate) noise_conns: Arc<Semaphore>,
    pub(crate) max_noise_conns: usize,
    /// Caps request bodies being buffered at once across all Noise connections
    /// (pre-auth memory bound: permits x MAX_CONTROL_BODY).
    pub(crate) noise_body_reads: Arc<Semaphore>,
}

/// Default instance-wide cap on concurrent Noise connections.
pub const DEFAULT_MAX_NOISE_CONNECTIONS: usize = 4096;
/// Concurrent control request bodies being read (256 x 256 KiB = 64 MiB max).
pub const MAX_CONCURRENT_BODY_READS: usize = 256;

impl CoordinatorState {
    pub fn new(control_key: ControlKey) -> Self {
        let fed_store: Arc<dyn FederationStore> = Arc::new(FederationMemoryStore::new());
        let fed_config = BrokerConfig::default();
        let store = Arc::new(Store::Memory(Box::new(MemoryStore::new())));
        let acl = Arc::new(PolicyEngine::new());
        let derp = Arc::new(DerpRegistry::new(default_derp_map()));
        let netmap = NetmapService::new(store.clone(), acl.clone(), derp.clone());
        let (config_changed, _) = broadcast::channel(256);
        Self {
            control_key,
            store,
            acl,
            derp,
            auto_approvers: Arc::new(AutoApproverRegistry::new()),
            admin_api_key: None,
            netmap,
            config_changed,
            federation_inbound: Arc::new(InboundHandler::new(
                fed_store.clone(),
                fed_config.clone(),
            )),
            federation_broker: Arc::new(BrokerService::new(fed_store, fed_config)),
            federation_callbacks: None,
            federation_enabled: true,
            noise_conns: Arc::new(Semaphore::new(DEFAULT_MAX_NOISE_CONNECTIONS)),
            max_noise_conns: DEFAULT_MAX_NOISE_CONNECTIONS,
            noise_body_reads: Arc::new(Semaphore::new(MAX_CONCURRENT_BODY_READS)),
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
        self.netmap = NetmapService::new(self.store.clone(), self.acl.clone(), self.derp.clone());
        self
    }

    pub fn with_derp_map(mut self, derp_map: DerpMap) -> Self {
        self.derp = Arc::new(DerpRegistry::new(derp_map));
        self.netmap = NetmapService::new(self.store.clone(), self.acl.clone(), self.derp.clone());
        self
    }

    /// Override the instance-wide concurrent Noise connection cap.
    pub fn with_max_noise_connections(mut self, max: usize) -> Self {
        self.noise_conns = Arc::new(Semaphore::new(max));
        self.max_noise_conns = max;
        self
    }

    pub fn with_admin_api_key(mut self, key: Option<String>) -> Self {
        self.admin_api_key = key;
        self
    }

    /// When false, the CFP federation endpoints are not mounted (the TS service is authoritative).
    pub fn with_federation_enabled(mut self, enabled: bool) -> Self {
        self.federation_enabled = enabled;
        self
    }

    pub fn federation_enabled(&self) -> bool {
        self.federation_enabled
    }

    pub fn with_federation_callbacks(mut self, cb: Arc<dyn HandshakeCallbacks>) -> Self {
        self.federation_callbacks = Some(cb);
        self
    }

    pub fn notify_tenant_changed(&self, tenant: TenantId) {
        let _ = self.config_changed.send(tenant);
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

    pub fn derp(&self) -> &Arc<DerpRegistry> {
        &self.derp
    }

    pub fn auto_approvers(&self) -> &Arc<AutoApproverRegistry> {
        &self.auto_approvers
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
