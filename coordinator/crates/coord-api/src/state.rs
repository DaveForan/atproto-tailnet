use std::sync::Arc;
use tokio::sync::{broadcast, Semaphore};
use coord_core::{ControlKey, TenantId};
use coord_acl::PolicyEngine;
use coord_federation::{
    BrokerConfig, BrokerService, FederationMemoryStore, FederationStore,
    HandshakeCallbacks, InboundHandler,
};
use coord_netmap::{AutoApproverRegistry, DerpRegistry, IdentityRegistry, NetmapService};
use coord_derp::{DerpConfig, DerpServer};
use coord_proto::map::{DerpMap, DerpNode, DerpRegion};
use coord_store::{MemoryStore, Store};

pub struct CoordinatorState {
    pub(crate) control_key: ControlKey,
    pub(crate) store: Arc<Store>,
    pub(crate) acl: Arc<PolicyEngine>,
    pub(crate) derp: Arc<DerpRegistry>,
    /// Per-tenant route auto-approvers (in-memory; TS service replays them).
    pub(crate) auto_approvers: Arc<AutoApproverRegistry>,
    /// Per-tenant tailnet/user names shown in clients (in-memory; TS service replays them).
    pub(crate) identity: Arc<IdentityRegistry>,
    /// Built-in DERP relay (ADR-0027). Always present; it only carries traffic
    /// when a DERP map points clients at this server.
    pub(crate) relay: Arc<DerpServer>,
    relay_secret: [u8; 32],
    /// Pending interactive device sign-ins (ADR-0032).
    pub(crate) device_auth: Arc<crate::device_auth::DeviceAuthRegistry>,
    /// Base of the sign-in URL sent to devices (`<base>/<id>`); `None` = auth keys only.
    pub(crate) device_auth_url: Option<String>,
    pub(crate) device_auth_wait: std::time::Duration,
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
        let identity = Arc::new(IdentityRegistry::new());
        let netmap = NetmapService::with_identity(store.clone(), acl.clone(), derp.clone(), identity.clone());
        let (config_changed, _) = broadcast::channel(256);
        let relay_secret = random_secret();
        let relay = build_relay(relay_secret, &store);
        Self {
            control_key,
            relay,
            relay_secret,
            device_auth: crate::device_auth::DeviceAuthRegistry::new(),
            device_auth_url: None,
            device_auth_wait: crate::device_auth::FOLLOWUP_WAIT,
            store,
            acl,
            derp,
            auto_approvers: Arc::new(AutoApproverRegistry::new()),
            identity,
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
        self.relay = build_relay(self.relay_secret, &self.store);
        self.netmap = NetmapService::with_identity(self.store.clone(), self.acl.clone(), self.derp.clone(), self.identity.clone());
        self
    }

    pub fn with_derp_map(mut self, derp_map: DerpMap) -> Self {
        self.derp = Arc::new(DerpRegistry::new(derp_map));
        self.netmap = NetmapService::with_identity(self.store.clone(), self.acl.clone(), self.derp.clone(), self.identity.clone());
        self
    }

    /// Enable interactive device sign-in: devices without a key are sent to
    /// `<base>/<id>` on the dashboard.
    pub fn with_device_auth_url(mut self, base: Option<String>) -> Self {
        self.device_auth_url = base.filter(|b| !b.is_empty());
        self
    }

    /// How long a device's follow-up request waits for the user (tests shorten it).
    pub fn with_device_auth_wait(mut self, wait: std::time::Duration) -> Self {
        self.device_auth_wait = wait;
        self
    }

    pub fn device_auth(&self) -> &Arc<crate::device_auth::DeviceAuthRegistry> {
        &self.device_auth
    }

    /// Use a persistent relay key so clients see the same relay identity
    /// after a restart (the default is a fresh random key per process).
    pub fn with_relay_secret(mut self, secret: [u8; 32]) -> Self {
        self.relay_secret = secret;
        self.relay = build_relay(secret, &self.store);
        self
    }

    /// Make the built-in relay the default DERP region for every tenant:
    /// clients reach it at `https://<hostname>/derp` and STUN on `stun_port`.
    pub fn with_builtin_relay_region(self, hostname: &str, stun_port: u16) -> Self {
        self.with_derp_map(builtin_relay_map(hostname, stun_port))
    }

    pub fn relay(&self) -> &Arc<DerpServer> {
        &self.relay
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

    pub fn identity(&self) -> &Arc<IdentityRegistry> {
        &self.identity
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

/// Region id of the built-in relay in the default DERP map.
pub const BUILTIN_RELAY_REGION_ID: i32 = 1;

/// The default DERP map has no regions: nothing is relayed through third
/// parties. Deployments enable the built-in relay
/// ([`CoordinatorState::with_builtin_relay_region`]) or load their own map.
fn default_derp_map() -> DerpMap {
    DerpMap { regions: std::collections::HashMap::new(), omit_default_regions: Some(true) }
}

/// A DERP map whose only region is this coordinator's built-in relay.
pub fn builtin_relay_map(hostname: &str, stun_port: u16) -> DerpMap {
    let mut regions = std::collections::HashMap::new();
    regions.insert(
        BUILTIN_RELAY_REGION_ID,
        DerpRegion {
            region_id: BUILTIN_RELAY_REGION_ID,
            region_code: "home".into(),
            region_name: "Built-in relay".into(),
            nodes: vec![DerpNode {
                name: "1a".into(),
                region_id: BUILTIN_RELAY_REGION_ID,
                host_name: hostname.into(),
                cert_name: None,
                ipv4: None,
                ipv6: None,
                stun_port,
                derp_port: 443,
                stun_only: None,
                insecure_for_tests: None,
            }],
        },
    );
    DerpMap { regions, omit_default_regions: Some(true) }
}

fn random_secret() -> [u8; 32] {
    use rand::RngCore;
    let mut secret = [0u8; 32];
    rand::rng().fill_bytes(&mut secret);
    secret
}

fn build_relay(secret: [u8; 32], store: &Arc<Store>) -> Arc<DerpServer> {
    let admission = Arc::new(crate::derp_handler::StoreAdmission { store: store.clone() });
    Arc::new(DerpServer::new(secret, admission, DerpConfig::default()))
}
