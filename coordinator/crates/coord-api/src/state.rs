use std::sync::Arc;
use tokio::sync::{broadcast, Semaphore};
use coord_core::{ControlKey, SignInLimits, TenantId};
use coord_acl::PolicyEngine;
use coord_federation::{
    BrokerConfig, BrokerService, FederationMemoryStore, FederationStore,
    HandshakeCallbacks, InboundHandler,
};
use coord_netmap::{AutoApproverRegistry, DerpRegistry, IdentityRegistry, NetmapService, TenantCaches};
use coord_derp::{DerpConfig, DerpServer};
use coord_proto::map::{DerpMap, DerpNode, DerpRegion};
use coord_store::{MemoryStore, Store};

pub use coord_netmap::{CONFIG_ACL, CONFIG_AUTO_APPROVERS, CONFIG_DERP, CONFIG_GATEWAY, CONFIG_IDENTITY};

/// What a tenant-changed notification covers. Live map streams resend a snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigChange {
    Tenant(TenantId),
    All,
}

impl ConfigChange {
    pub fn covers(self, tenant: TenantId) -> bool {
        match self {
            ConfigChange::Tenant(t) => t == tenant,
            ConfigChange::All => true,
        }
    }
}

pub struct CoordinatorState {
    pub(crate) control_key: ControlKey,
    pub(crate) store: Arc<Store>,
    /// Per-tenant configuration caches (ACL, DERP, auto-approvers, identity, gateway node).
    pub(crate) caches: TenantCaches,
    /// Built-in DERP relay (ADR-0027). It carries traffic only when a DERP map points clients here.
    pub(crate) relay: Arc<DerpServer>,
    /// Pending interactive device sign-ins (ADR-0032).
    pub(crate) device_auth: Arc<crate::device_auth::DeviceAuthRegistry>,
    /// Base of the sign-in URL sent to devices (`<base>/<id>`); `None` = auth keys only.
    pub(crate) device_auth_url: Option<String>,
    pub(crate) device_auth_wait: std::time::Duration,
    pub(crate) sign_in_limits: SignInLimits,
    pub(crate) admin_api_key: Option<String>,
    /// Which parts this process serves (ADR-0034).
    pub(crate) role: Role,
    /// This process's relay region, when it is a relay with a public hostname.
    pub(crate) own_relay: Option<coord_core::RelayInfo>,
    /// Set when this process runs gateways (ADR-0029).
    pub(crate) gateways_cfg: std::sync::OnceLock<Arc<crate::gateway::Gateways>>,
    /// Set when the gateways of this process answer disco and use UDP paths (ADR-0029 phase 2).
    pub(crate) gateway_direct: Option<crate::gateway::GatewayDirect>,
    pub(crate) netmap: NetmapService,
    pub(crate) config_changed: broadcast::Sender<ConfigChange>,
    pub(crate) federation_inbound: Arc<InboundHandler<dyn FederationStore>>,
    pub(crate) federation_broker: Arc<BrokerService<dyn FederationStore>>,
    pub(crate) federation_callbacks: Option<Arc<dyn HandshakeCallbacks>>,
    pub(crate) federation_enabled: bool,
    /// Caps simultaneous Noise (ts2021) connections instance-wide.
    pub(crate) noise_conns: Arc<Semaphore>,
    pub(crate) max_noise_conns: usize,
    /// Caps simultaneous Noise connections per client address (behind Caddy: from `trusted_proxies`).
    pub(crate) noise_per_ip: Arc<crate::conn_limit::PerIpLimiter>,
    /// A Noise session that has not authenticated within this time is closed.
    pub(crate) noise_auth_deadline: std::time::Duration,
    /// Rate limit the warnings about refused admin, relay and Noise requests.
    pub(crate) admin_auth_log: crate::log_limit::LogLimiter,
    pub(crate) relay_refused_log: crate::log_limit::LogLimiter,
    pub(crate) noise_refused_log: crate::log_limit::LogLimiter,
    /// Caps request bodies buffered at once across all Noise connections
    /// (pre-auth memory bound: permits x MAX_CONTROL_BODY).
    pub(crate) noise_body_reads: Arc<Semaphore>,
    /// Interval of the full snapshot every live map stream sends (safety net for lost notifications).
    pub(crate) stream_resync_period: std::time::Duration,
    /// Proxies whose X-Forwarded-For is believed (`COORD_TRUSTED_PROXIES`).
    pub(crate) trusted_proxies: crate::client_ip::TrustedProxies,
}

/// Default interval of the periodic full snapshot of a live map stream.
pub const STREAM_RESYNC_PERIOD: std::time::Duration = std::time::Duration::from_secs(300);

/// Default instance-wide cap on concurrent Noise connections.
pub const DEFAULT_MAX_NOISE_CONNECTIONS: usize = 4096;
/// Default cap on concurrent Noise connections from one client address (a NAT can hide many devices).
pub const DEFAULT_MAX_NOISE_CONNECTIONS_PER_IP: usize = 256;
/// Default time a Noise session has to register or poll the map as a known machine.
pub const NOISE_AUTH_DEADLINE: std::time::Duration = std::time::Duration::from_secs(30);
/// At most one warning per client address in this interval for refused admin or relay requests.
pub const SECURITY_LOG_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);
/// Concurrent control request bodies being read (256 x 256 KiB = 64 MiB max).
pub const MAX_CONCURRENT_BODY_READS: usize = 256;

/// Configuration of a [`CoordinatorState`]. `build` wires the netmap and the relay once.
pub struct CoordinatorStateBuilder {
    control_key: ControlKey,
    store: Option<Store>,
    derp_map: DerpMap,
    relay_secret: Option<[u8; 32]>,
    own_relay: Option<coord_core::RelayInfo>,
    device_auth_url: Option<String>,
    device_auth_wait: std::time::Duration,
    sign_in_limits: SignInLimits,
    admin_api_key: Option<String>,
    role: Role,
    gateway: Option<([u8; 32], Arc<coord_gateway::proxy::Certificate>)>,
    gateway_direct: Option<crate::gateway::GatewayDirect>,
    federation_store: Option<Arc<dyn FederationStore>>,
    federation_callbacks: Option<Arc<dyn HandshakeCallbacks>>,
    federation_enabled: bool,
    max_noise_conns: usize,
    max_noise_conns_per_ip: usize,
    noise_auth_deadline: std::time::Duration,
    stream_resync_period: std::time::Duration,
    trusted_proxies: crate::client_ip::TrustedProxies,
}

/// A configuration that must not start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigError {
    /// Federation is on, but nothing answers the CFP handshake.
    FederationWithoutCallbacks,
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfigError::FederationWithoutCallbacks => f.write_str(
                "federation is enabled but no federation handshake callbacks are configured; \
                 unset COORD_FEDERATION_ENABLED (the TS service is the federation endpoint)",
            ),
        }
    }
}

impl std::error::Error for ConfigError {}

impl CoordinatorStateBuilder {
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
        self.federation_store = Some(store);
        self
    }

    pub fn with_store(mut self, store: Store) -> Self {
        self.store = Some(store);
        self
    }

    /// Replace the default DERP map (also replaces a map set by `with_relay_identity`).
    pub fn with_derp_map(mut self, derp_map: DerpMap) -> Self {
        self.derp_map = derp_map;
        self
    }

    /// Enable interactive device sign-in: devices without a key go to `<base>/<id>`.
    pub fn with_device_auth_url(mut self, base: Option<String>) -> Self {
        self.device_auth_url = base.filter(|b| !b.is_empty());
        self
    }

    /// How long a device's follow-up request waits for the user (tests shorten it).
    pub fn with_device_auth_wait(mut self, wait: std::time::Duration) -> Self {
        self.device_auth_wait = wait;
        self
    }

    /// Caps on pending device sign-ins.
    pub fn with_sign_in_limits(mut self, limits: SignInLimits) -> Self {
        self.sign_in_limits = limits;
        self
    }

    /// Persistent relay key, so clients see the same relay identity after a restart.
    pub fn with_relay_secret(mut self, secret: [u8; 32]) -> Self {
        self.relay_secret = Some(secret);
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

    /// This process is a relay with a public hostname and its own DERP region.
    /// The region becomes the default map of this process. Other control replicas find it in the store.
    pub fn with_relay_identity(mut self, relay: coord_core::RelayInfo) -> Self {
        let mut regions = std::collections::HashMap::new();
        regions.insert(relay.region_id, relay_region(&relay));
        self.own_relay = Some(relay);
        self.with_derp_map(DerpMap { regions, omit_default_regions: Some(true) })
    }

    /// Run gateways in this process: `secret` gives each tenant's gateway its
    /// keys, `certificate` is the wildcard certificate of the base domain.
    pub fn with_gateway(mut self, secret: [u8; 32], certificate: Arc<coord_gateway::proxy::Certificate>) -> Self {
        self.gateway = Some((secret, certificate));
        self
    }

    /// Direct paths to the gateways of this process: one UDP socket for all tailnets,
    /// and the public addresses of that socket as devices must see them.
    pub fn with_gateway_direct(mut self, socket: coord_gateway::direct::DirectSocket, endpoints: Vec<std::net::SocketAddr>) -> Self {
        self.gateway_direct = Some(crate::gateway::GatewayDirect { socket: Arc::new(socket), endpoints });
        self
    }

    pub fn with_role(mut self, role: Role) -> Self {
        self.role = role;
        self
    }

    /// Override the instance-wide concurrent Noise connection cap.
    pub fn with_max_noise_connections(mut self, max: usize) -> Self {
        self.max_noise_conns = max;
        self
    }

    /// Override the concurrent Noise connection cap per client address.
    pub fn with_max_noise_connections_per_ip(mut self, max: usize) -> Self {
        self.max_noise_conns_per_ip = max;
        self
    }

    /// Change how long a Noise session may stay unauthenticated (tests shorten it).
    pub fn with_noise_auth_deadline(mut self, deadline: std::time::Duration) -> Self {
        self.noise_auth_deadline = deadline;
        self
    }

    pub fn with_admin_api_key(mut self, key: Option<String>) -> Self {
        self.admin_api_key = key;
        self
    }

    /// Mount the CFP federation endpoints (default off: the TS service is authoritative).
    pub fn with_federation_enabled(mut self, enabled: bool) -> Self {
        self.federation_enabled = enabled;
        self
    }

    pub fn with_federation_callbacks(mut self, cb: Arc<dyn HandshakeCallbacks>) -> Self {
        self.federation_callbacks = Some(cb);
        self
    }

    /// Check that the configuration can serve what it enables.
    ///
    /// # Errors
    /// [`ConfigError::FederationWithoutCallbacks`] when federation is on without handshake callbacks.
    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.federation_enabled && self.federation_callbacks.is_none() {
            return Err(ConfigError::FederationWithoutCallbacks);
        }
        Ok(())
    }

    pub fn build(self) -> CoordinatorState {
        let store = Arc::new(self.store.unwrap_or_else(|| Store::Memory(Box::new(MemoryStore::new()))));
        let caches = TenantCaches::new(self.derp_map);
        let netmap = caches.netmap(store.clone());
        let relay = build_relay(self.relay_secret.unwrap_or_else(random_secret), &store);
        let fed_store = self.federation_store.unwrap_or_else(|| Arc::new(FederationMemoryStore::new()));
        let fed_config = BrokerConfig::default();
        let (config_changed, _) = broadcast::channel(256);
        let gateways_cfg = std::sync::OnceLock::new();
        if let Some((secret, certificate)) = self.gateway {
            let _ = gateways_cfg.set(Arc::new(crate::gateway::Gateways::new(secret, certificate)));
        }
        CoordinatorState {
            control_key: self.control_key,
            store,
            caches,
            relay,
            device_auth: crate::device_auth::DeviceAuthRegistry::new(),
            device_auth_url: self.device_auth_url,
            device_auth_wait: self.device_auth_wait,
            sign_in_limits: self.sign_in_limits,
            admin_api_key: self.admin_api_key,
            role: self.role,
            own_relay: self.own_relay,
            gateways_cfg,
            gateway_direct: self.gateway_direct,
            netmap,
            config_changed,
            federation_inbound: Arc::new(InboundHandler::new(fed_store.clone(), fed_config.clone())),
            federation_broker: Arc::new(BrokerService::new(fed_store, fed_config)),
            federation_callbacks: self.federation_callbacks,
            federation_enabled: self.federation_enabled,
            noise_conns: Arc::new(Semaphore::new(self.max_noise_conns)),
            max_noise_conns: self.max_noise_conns,
            noise_per_ip: crate::conn_limit::PerIpLimiter::new(self.max_noise_conns_per_ip),
            noise_auth_deadline: self.noise_auth_deadline,
            admin_auth_log: crate::log_limit::LogLimiter::new(SECURITY_LOG_INTERVAL),
            relay_refused_log: crate::log_limit::LogLimiter::new(SECURITY_LOG_INTERVAL),
            noise_refused_log: crate::log_limit::LogLimiter::new(SECURITY_LOG_INTERVAL),
            noise_body_reads: Arc::new(Semaphore::new(MAX_CONCURRENT_BODY_READS)),
            stream_resync_period: self.stream_resync_period,
            trusted_proxies: self.trusted_proxies,
        }
    }
}

impl CoordinatorState {
    /// A state with every default: memory store, empty DERP map, federation off.
    pub fn new(control_key: ControlKey) -> Self {
        Self::builder(control_key).build()
    }

    pub fn builder(control_key: ControlKey) -> CoordinatorStateBuilder {
        CoordinatorStateBuilder {
            control_key,
            store: None,
            derp_map: default_derp_map(),
            relay_secret: None,
            own_relay: None,
            device_auth_url: None,
            device_auth_wait: crate::device_auth::FOLLOWUP_WAIT,
            sign_in_limits: SignInLimits::default(),
            admin_api_key: None,
            role: Role::All,
            gateway: None,
            gateway_direct: None,
            federation_store: None,
            federation_callbacks: None,
            federation_enabled: false,
            max_noise_conns: DEFAULT_MAX_NOISE_CONNECTIONS,
            max_noise_conns_per_ip: DEFAULT_MAX_NOISE_CONNECTIONS_PER_IP,
            noise_auth_deadline: NOISE_AUTH_DEADLINE,
            stream_resync_period: STREAM_RESYNC_PERIOD,
            trusted_proxies: crate::client_ip::TrustedProxies::default(),
        }
    }

    pub fn device_auth(&self) -> &Arc<crate::device_auth::DeviceAuthRegistry> {
        &self.device_auth
    }

    #[cfg(feature = "test-hooks")]
    #[doc(hidden)]
    pub fn __test_config_changes(&self) -> broadcast::Receiver<ConfigChange> {
        self.config_changed.subscribe()
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

    pub fn role(&self) -> Role {
        self.role
    }

    /// One round of relay discovery: report this relay as alive, and (on a
    /// control process) rebuild the default DERP map from the live relays.
    /// Devices get the new map when it changed.
    pub async fn refresh_relays(&self) {
        if let Some(relay) = self.own_relay.as_ref().filter(|_| self.role.serves_relay())
            && let Err(e) = self.store.relay_heartbeat(relay).await {
                tracing::warn!(error = %e, "relay heartbeat failed");
            }
        if self.role.serves_control() {
            let live = self.store.list_relays(coord_core::relay::RELAY_STALE_SECS).await;
            if self.caches.derp.set_relay_regions(live.iter().map(relay_region).collect()) {
                tracing::info!(relays = live.len(), "default DERP map changed");
                let _ = self.config_changed.send(ConfigChange::All);
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

    pub fn federation_enabled(&self) -> bool {
        self.federation_enabled
    }

    /// Something about a tenant changed: live map streams of this process
    /// send a new snapshot, and the other replicas are told to do the same.
    pub fn notify_tenant_changed(&self, tenant: TenantId) {
        let _ = self.config_changed.send(ConfigChange::Tenant(tenant));
        let store = self.store.clone();
        tokio::spawn(async move { store.publish(coord_store::RemoteEvent::TenantChanged(tenant)).await });
    }

    /// Persists one tenant configuration value (ADR-0034). The registries in this process only cache the store.
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
        self.caches.forget(tenant);
    }

    /// Fills the caches from the store. Call at startup and after notifications may have been lost.
    /// Cached tenants without stored configuration are cleared.
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
            self.caches.replace(tenant, stored);
        }
        tracing::info!(count, "tenant configuration loaded from the store");
    }

    /// Replace the cached configuration of one tenant with what the store
    /// holds. On a store error the cache is left as it is.
    pub async fn reload_tenant_config(&self, tenant: TenantId) {
        match self.store.get_tenant_configs(tenant).await {
            Ok(stored) => self.caches.replace(tenant, stored),
            Err(e) => tracing::error!(tenant = %tenant, error = %e, "could not reload tenant configuration; keeping the cache"),
        }
    }

    /// Recovers from missed notifications: reloads all configuration.
    /// Every live stream re-checks its node, tenant, suspension and machine lock, then sends a full snapshot.
    pub async fn resync_all(self: &Arc<Self>) {
        self.load_config().await;
        for tenant in self.store.list_tenants().await {
            self.sync_gateway(tenant.id).await;
        }
        self.relay.rescope(None).await;
        let _ = self.config_changed.send(ConfigChange::All);
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
                        state.refresh_relay_scopes(tenant).await;
                        let _ = state.config_changed.send(ConfigChange::Tenant(tenant));
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
        &self.caches.acl
    }

    pub fn derp(&self) -> &Arc<DerpRegistry> {
        &self.caches.derp
    }

    pub fn identity(&self) -> &Arc<IdentityRegistry> {
        &self.caches.identity
    }

    pub fn auto_approvers(&self) -> &Arc<AutoApproverRegistry> {
        &self.caches.auto_approvers
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
/// ([`CoordinatorStateBuilder::with_builtin_relay_region`]) or load their own map.
fn default_derp_map() -> DerpMap {
    DerpMap { regions: std::collections::HashMap::new(), omit_default_regions: Some(true) }
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
