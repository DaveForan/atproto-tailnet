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
    /// Which parts this process serves (ADR-0034).
    pub(crate) role: Role,
    /// This process's relay region, when it is a relay with a public hostname.
    pub(crate) own_relay: Option<coord_core::RelayInfo>,
    /// The gateway node of each tenant that has one (cache of the store).
    pub(crate) gateway_nodes: Arc<coord_netmap::GatewayRegistry>,
    /// Set when this process runs gateways (ADR-0029).
    pub(crate) gateways_cfg: std::sync::OnceLock<Arc<crate::gateway::Gateways>>,
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
    /// Interval of the full snapshot every live map stream sends regardless
    /// of events (safety net for lost notifications).
    pub(crate) stream_resync_period: std::time::Duration,
    /// Proxies whose X-Forwarded-For is believed (`COORD_TRUSTED_PROXIES`).
    pub(crate) trusted_proxies: crate::client_ip::TrustedProxies,
}

/// Default interval of the periodic full snapshot of a live map stream.
pub const STREAM_RESYNC_PERIOD: std::time::Duration = std::time::Duration::from_secs(300);

/// Kinds of per-tenant configuration kept in the store (`coord_tenant_config`).
pub const CONFIG_ACL: &str = "acl";
pub const CONFIG_DERP: &str = "derp";
pub const CONFIG_AUTO_APPROVERS: &str = "auto_approvers";
pub const CONFIG_IDENTITY: &str = "identity";
/// The gateway node of the tenant: `{ "node_id": … }`.
pub const CONFIG_GATEWAY: &str = "gateway";

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
        let gateway_nodes = Arc::new(coord_netmap::GatewayRegistry::new());
        let netmap = NetmapService::with_identity(store.clone(), acl.clone(), derp.clone(), identity.clone()).with_gateways(gateway_nodes.clone());
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
            role: Role::All,
            own_relay: None,
            gateway_nodes,
            gateways_cfg: std::sync::OnceLock::new(),
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
            stream_resync_period: STREAM_RESYNC_PERIOD,
            trusted_proxies: crate::client_ip::TrustedProxies::default(),
        }
    }

    /// Proxies (Caddy) whose X-Forwarded-For gives the client address.
    pub fn with_trusted_proxies(mut self, proxies: crate::client_ip::TrustedProxies) -> Self {
        self.trusted_proxies = proxies;
        self
    }

    /// Change the periodic full-snapshot interval of live map streams (tests shorten it).
    pub fn with_stream_resync_period(mut self, period: std::time::Duration) -> Self {
        self.stream_resync_period = period.max(std::time::Duration::from_millis(10));
        self
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
        self.netmap = NetmapService::with_identity(self.store.clone(), self.acl.clone(), self.derp.clone(), self.identity.clone()).with_gateways(self.gateway_nodes.clone());
        self
    }

    pub fn with_derp_map(mut self, derp_map: DerpMap) -> Self {
        self.derp = Arc::new(DerpRegistry::new(derp_map));
        self.netmap = NetmapService::with_identity(self.store.clone(), self.acl.clone(), self.derp.clone(), self.identity.clone()).with_gateways(self.gateway_nodes.clone());
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
        self.with_relay_identity(coord_core::RelayInfo {
            region_id: BUILTIN_RELAY_REGION_ID,
            hostname: hostname.into(),
            stun_port,
        })
    }

    /// This process is a relay with a public hostname and its own DERP
    /// region. It is in the default map of this process at once, and other
    /// control replicas find it in the store (`spawn_relay_tasks`).
    pub fn with_relay_identity(mut self, relay: coord_core::RelayInfo) -> Self {
        let mut regions = std::collections::HashMap::new();
        regions.insert(relay.region_id, relay_region(&relay));
        self.own_relay = Some(relay);
        self.with_derp_map(DerpMap { regions, omit_default_regions: Some(true) })
    }

    #[doc(hidden)]
    pub fn __test_config_changes(&self) -> broadcast::Receiver<TenantId> {
        self.config_changed.subscribe()
    }

    /// Run gateways in this process: `secret` gives each tenant's gateway its
    /// keys, `certificate` is the wildcard certificate of the base domain.
    pub fn with_gateway(self, secret: [u8; 32], certificate: Arc<coord_gateway::proxy::Certificate>) -> Self {
        let _ = self.gateways_cfg.set(Arc::new(crate::gateway::Gateways::new(secret, certificate)));
        self
    }

    /// Turn the gateway on in a running process (the certificate can arrive
    /// after start-up). Returns false when it was already on.
    pub async fn enable_gateway(
        self: &Arc<Self>,
        secret: [u8; 32],
        certificate: Arc<coord_gateway::proxy::Certificate>,
    ) -> bool {
        if self.gateways_cfg.set(Arc::new(crate::gateway::Gateways::new(secret, certificate))).is_err() {
            return false;
        }
        self.start_gateways().await;
        true
    }

    pub fn gateways(&self) -> Option<&Arc<crate::gateway::Gateways>> {
        self.gateways_cfg.get()
    }

    pub fn with_role(mut self, role: Role) -> Self {
        self.role = role;
        self
    }

    pub fn role(&self) -> Role {
        self.role
    }

    /// One round of relay discovery: report this relay as alive, and (on a
    /// control process) rebuild the default DERP map from the live relays.
    /// Devices get the new map when it changed.
    pub async fn refresh_relays(&self) {
        if let Some(relay) = self.own_relay.as_ref().filter(|_| self.role.serves_relay()) {
            if let Err(e) = self.store.relay_heartbeat(relay).await {
                tracing::warn!(error = %e, "relay heartbeat failed");
            }
        }
        if self.role.serves_control() {
            let live = self.store.list_relays(coord_core::relay::RELAY_STALE_SECS).await;
            if self.derp.set_relay_regions(live.iter().map(relay_region).collect()) {
                tracing::info!(relays = live.len(), "default DERP map changed");
                let _ = self.config_changed.send(all_tenants());
            }
        }
    }

    /// Keep relay discovery running. Call once at startup, after a first `refresh_relays`.
    pub fn spawn_relay_tasks(self: &Arc<Self>) {
        let state = self.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(coord_core::relay::RELAY_HEARTBEAT_SECS));
            tick.tick().await;
            loop {
                tick.tick().await;
                state.refresh_relays().await;
            }
        });
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

    /// Something about a tenant changed: live map streams of this process
    /// send a new snapshot, and the other replicas are told to do the same.
    pub fn notify_tenant_changed(&self, tenant: TenantId) {
        let _ = self.config_changed.send(tenant);
        if matches!(*self.store, Store::Pg(_)) {
            let store = self.store.clone();
            tokio::spawn(async move { store.publish(coord_store::RemoteEvent::TenantChanged(tenant)).await });
        }
    }

    /// Persist one configuration value of a tenant (ADR-0034). The registries
    /// in this process are caches of what the store holds.
    pub(crate) async fn save_config<T: serde::Serialize>(
        &self,
        tenant: TenantId,
        kind: &str,
        value: &T,
    ) -> Result<(), axum::response::Response> {
        use axum::response::IntoResponse;
        let json = serde_json::to_value(value).unwrap_or_default();
        self.store.set_tenant_config(tenant, kind, Some(json)).await.map_err(|e| {
            let status = match e {
                coord_core::CoordError::TenantNotFound(_) => axum::http::StatusCode::NOT_FOUND,
                _ => axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            };
            tracing::error!(error = %e, kind, "failed to store tenant configuration");
            (status, axum::Json(serde_json::json!({ "error": "could not store the configuration" }))).into_response()
        })
    }

    pub(crate) fn forget_tenant_config(&self, tenant: TenantId) {
        self.acl.remove_policy(tenant);
        self.derp.remove_tenant(tenant);
        self.auto_approvers.remove_tenant(tenant);
        self.identity.remove_tenant(tenant);
        self.gateway_nodes.remove(tenant);
    }

    /// Make the cached configuration of one tenant equal `stored`. Every value
    /// is parsed first; then each registry entry is replaced in one step (set,
    /// or removed when the kind is no longer stored). A netmap built meanwhile
    /// sees either the old or the new entry, never an empty gap. A value that
    /// cannot be read keeps the cached entry.
    fn replace_tenant_config(&self, tenant: TenantId, stored: Vec<(String, serde_json::Value)>) {
        fn parse<T: serde::de::DeserializeOwned>(tenant: TenantId, kind: &str, v: Option<serde_json::Value>) -> Option<Option<T>> {
            match v.map(serde_json::from_value::<T>) {
                None => Some(None),
                Some(Ok(t)) => Some(Some(t)),
                Some(Err(e)) => {
                    tracing::warn!(tenant = %tenant, kind, error = %e, "stored tenant configuration could not be read; keeping the cached value");
                    None
                }
            }
        }
        let mut by_kind: std::collections::HashMap<String, serde_json::Value> = stored.into_iter().collect();
        let acl = parse::<coord_acl::AclPolicy>(tenant, CONFIG_ACL, by_kind.remove(CONFIG_ACL));
        let derp = parse::<coord_netmap::TenantDerp>(tenant, CONFIG_DERP, by_kind.remove(CONFIG_DERP));
        let approvers = parse::<coord_netmap::AutoApprovers>(tenant, CONFIG_AUTO_APPROVERS, by_kind.remove(CONFIG_AUTO_APPROVERS));
        let identity = parse::<coord_netmap::TenantIdentity>(tenant, CONFIG_IDENTITY, by_kind.remove(CONFIG_IDENTITY));
        let gateway = match by_kind.remove(CONFIG_GATEWAY) {
            None => Some(None),
            Some(v) => match v.get("node_id").and_then(|n| n.as_i64()) {
                Some(n) => Some(Some(n)),
                None => {
                    tracing::warn!(tenant = %tenant, kind = CONFIG_GATEWAY, "stored tenant configuration could not be read; keeping the cached value");
                    None
                }
            },
        };
        // Kinds written by a newer version are ignored (left in `by_kind`).
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
            Some(Some(n)) => self.gateway_nodes.set(tenant, n),
            Some(None) => self.gateway_nodes.remove(tenant),
            None => {}
        }
    }

    /// Fill the caches from the store. Call once at startup, and after
    /// notifications may have been lost: every tenant with stored
    /// configuration is replaced, and cached tenants with none are cleared.
    pub async fn load_config(&self) {
        let all = match self.store.list_tenant_configs().await {
            Ok(all) => all,
            Err(e) => {
                tracing::error!(error = %e, "could not load tenant configuration; keeping the cache");
                return;
            }
        };
        let count = all.len();
        let mut by_tenant: std::collections::HashMap<TenantId, Vec<(String, serde_json::Value)>> = std::collections::HashMap::new();
        for (tenant, kind, value) in all {
            by_tenant.entry(tenant).or_default().push((kind, value));
        }
        for tenant in self.store.list_tenants().await.into_iter().map(|t| t.id) {
            by_tenant.entry(tenant).or_default();
        }
        for (tenant, stored) in by_tenant {
            self.replace_tenant_config(tenant, stored);
        }
        tracing::info!(count, "tenant configuration loaded from the store");
    }

    /// Replace the cached configuration of one tenant with what the store
    /// holds. On a store error the cache is left as it is.
    pub async fn reload_tenant_config(&self, tenant: TenantId) {
        match self.store.get_tenant_configs(tenant).await {
            Ok(stored) => self.replace_tenant_config(tenant, stored),
            Err(e) => tracing::error!(tenant = %tenant, error = %e, "could not reload tenant configuration; keeping the cache"),
        }
    }

    /// Everything may be stale (missed notifications): reload every tenant's
    /// configuration and make every live stream re-check its node, tenant,
    /// suspension and machine lock and send a full snapshot.
    pub async fn resync_all(self: &Arc<Self>) {
        self.load_config().await;
        for tenant in self.store.list_tenants().await {
            self.sync_gateway(tenant.id).await;
        }
        let _ = self.config_changed.send(all_tenants());
    }

    /// React to what other replicas did (ADR-0034). Call once at startup.
    pub fn spawn_replica_listener(self: &Arc<Self>) {
        let state = self.clone();
        let mut events = self.store.subscribe_remote();
        tokio::spawn(async move {
            use tokio::sync::broadcast::error::RecvError;
            loop {
                match events.recv().await {
                    Ok(coord_store::RemoteEvent::TenantChanged(tenant)) => {
                        state.reload_tenant_config(tenant).await;
                        state.sync_gateway(tenant).await;
                        let _ = state.config_changed.send(tenant);
                    }
                    Ok(coord_store::RemoteEvent::SignInDecided(_)) => state.device_auth.wake(),
                    // Missed events (lost LISTEN connection, or this channel lagged)
                    Ok(coord_store::RemoteEvent::Resync) | Err(RecvError::Lagged(_)) => {
                        state.resync_all().await;
                        state.device_auth.wake();
                    }
                    Err(RecvError::Closed) => return,
                }
            }
        });
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

/// Sent on the tenant-changed channel when something changed for every tenant.
pub fn all_tenants() -> TenantId {
    TenantId::new(uuid::Uuid::nil())
}

/// Which parts of the coordinator a process serves (ADR-0034). Splitting the
/// roles lets control and relay replicas scale and fail separately.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Role {
    /// Control protocol, admin API and relay in one process (the default).
    #[default]
    All,
    /// Control protocol and admin API only.
    Control,
    /// DERP relay (and STUN) only.
    Relay,
}

impl Role {
    pub fn serves_control(self) -> bool {
        self != Role::Relay
    }

    pub fn serves_relay(self) -> bool {
        self != Role::Control
    }
}

impl std::str::FromStr for Role {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "all" | "" => Ok(Role::All),
            "control" => Ok(Role::Control),
            "relay" => Ok(Role::Relay),
            other => Err(format!("unknown role {other:?} (use all, control or relay)")),
        }
    }
}

/// The DERP region of one relay process.
pub fn relay_region(relay: &coord_core::RelayInfo) -> DerpRegion {
    DerpRegion {
        region_id: relay.region_id,
        region_code: if relay.region_id == BUILTIN_RELAY_REGION_ID { "home".into() } else { format!("relay-{}", relay.region_id) },
        region_name: if relay.region_id == BUILTIN_RELAY_REGION_ID { "Built-in relay".into() } else { format!("Relay {}", relay.region_id) },
        nodes: vec![DerpNode {
            name: format!("{}a", relay.region_id),
            region_id: relay.region_id,
            host_name: relay.hostname.clone(),
            cert_name: None,
            ipv4: None,
            ipv6: None,
            stun_port: relay.stun_port,
            derp_port: 443,
            stun_only: None,
            insecure_for_tests: None,
        }],
    }
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
