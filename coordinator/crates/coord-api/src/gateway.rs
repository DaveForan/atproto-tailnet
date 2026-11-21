//! The gateway inside the coordinator (ADR-0029, ADR-0030): a tagged, ownerless node on the built-in relay.
//! A tailnet with an HTTPS service gets one. It asks the store which device has a key or address,
//! and which service a caller may use.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddrV4};
use std::sync::{Arc, Mutex};

use coord_core::{DnsRecord, NodeId, NodeInfo, NodeRegistration, PeerInfo, TenantId};
use coord_derp::Scope;
use coord_gateway::netstack::NetStack;
use coord_gateway::proxy::{self, Certificate, Denied, Route, Services};
use coord_gateway::direct::DirectSocket;
use coord_gateway::tunnel::{public_key, Devices, Direct, Tailnet};
use coord_netmap::IdentityRegistry;
use coord_store::{PeerEvent, Store};
use tokio::sync::{broadcast, Notify};
use tracing::{error, info, warn};

use crate::state::{CoordinatorState, CONFIG_GATEWAY};

pub use coord_core::{GATEWAY_HOSTNAME, GATEWAY_TAG};

/// Direct paths to the gateways of this process (ADR-0029 phase 2).
pub struct GatewayDirect {
    pub(crate) socket: Arc<DirectSocket>,
    /// The addresses of the socket as devices see them. Empty: devices find no direct path.
    pub(crate) endpoints: Vec<std::net::SocketAddr>,
}

/// What the coordinator needs to run gateways.
pub struct Gateways {
    secret: [u8; 32],
    certificate: Arc<Certificate>,
    /// Running gateways. Dropping a stack handle stops that gateway.
    running: Mutex<HashMap<TenantId, NetStack>>,
}

impl Gateways {
    pub fn new(secret: [u8; 32], certificate: Arc<Certificate>) -> Self {
        Self { secret, certificate, running: Mutex::new(HashMap::new()) }
    }

    fn is_running(&self, tenant: TenantId) -> bool {
        self.running.lock().unwrap_or_else(|e| e.into_inner()).contains_key(&tenant)
    }

    pub fn running_count(&self) -> usize {
        self.running.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    pub(crate) fn stop(&self, tenant: TenantId) {
        self.running.lock().unwrap_or_else(|e| e.into_inner()).remove(&tenant);
    }
}

/// The key in a `discokey:<hex>` value.
fn disco_key(peer: &PeerInfo) -> Option<[u8; 32]> {
    hex::decode(peer.disco_key.as_deref()?.strip_prefix("discokey:")?).ok()?.try_into().ok()
}

fn first_addr(peer: &PeerInfo) -> Option<Ipv4Addr> {
    peer.addresses.first()?.split('/').next()?.parse().ok()
}

/// The devices of one tenant, as the gateway's WireGuard layer needs them.
struct StoreDevices {
    store: Arc<Store>,
    tenant: TenantId,
    gateway: NodeId,
    /// Woken when a node of the tenant joins, changes or goes away (see
    /// [`watch_devices`]): the WireGuard layer then forgets cached addresses.
    changed: Arc<Notify>,
}

/// Wake `changed` on every node change of `tenant` (a removed device, a new
/// key, an address given to another device), so the gateway does not use a
/// cached key or address after it changed. Ends when the gateway stops.
fn watch_devices(mut events: broadcast::Receiver<PeerEvent>, tenant: TenantId, changed: Arc<Notify>) {
    let alive = Arc::downgrade(&changed);
    drop(changed);
    tokio::spawn(async move {
        loop {
            let event = events.recv().await;
            let Some(changed) = alive.upgrade() else { return };
            match event {
                Ok(PeerEvent::NodeJoined { tenant_id, .. } | PeerEvent::NodeUpdated { tenant_id, .. } | PeerEvent::NodeOffline { tenant_id, .. }) => {
                    if tenant_id == tenant {
                        changed.notify_one();
                    }
                }
                // Missed events: assume that anything changed
                Err(broadcast::error::RecvError::Lagged(_)) => changed.notify_one(),
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    });
}

#[async_trait::async_trait]
impl Devices for StoreDevices {
    fn changes(&self) -> Option<Arc<Notify>> {
        Some(self.changed.clone())
    }

    async fn addr_of(&self, node_key: &[u8; 32]) -> Option<Ipv4Addr> {
        let peers = self.store.get_peers(self.tenant, self.gateway).await;
        peers.iter().find(|p| p.node_key.as_slice() == node_key).and_then(first_addr)
    }

    async fn key_of(&self, addr: Ipv4Addr) -> Option<[u8; 32]> {
        let peers = self.store.get_peers(self.tenant, self.gateway).await;
        let peer = peers.iter().find(|p| first_addr(p) == Some(addr))?;
        peer.node_key.as_slice().try_into().ok()
    }

    async fn disco_keys(&self) -> Vec<([u8; 32], [u8; 32])> {
        let peers = self.store.get_peers(self.tenant, self.gateway).await;
        peers.iter().filter_map(|p| Some((disco_key(p)?, p.node_key.as_slice().try_into().ok()?))).collect()
    }
}

/// The HTTPS services of one tenant: the DNS records that have a port.
struct StoreServices {
    store: Arc<Store>,
    identity: Arc<IdentityRegistry>,
    tenant: TenantId,
    gateway: NodeId,
    /// Service names are `<label>.<service_domain>` (ADR-0038).
    service_domain: String,
}

/// The HTTPS service record named `label` that this caller may use.
// Only records the caller may see count, so a private record cannot hide another member's public one.
// Order: public before private, then one naming the caller, then the lowest node and port.
fn pick_record<'a>(records: &'a [DnsRecord], label: &str, node: i64, owner: Option<&str>) -> Option<&'a DnsRecord> {
    records
        .iter()
        .filter(|r| r.name == label && r.port.is_some() && r.visible_to(node, owner))
        .min_by_key(|r| {
            let public = !r.nodes.is_empty() || r.owner.is_none();
            (!public, !r.nodes.contains(&node), r.node, r.port)
        })
}

#[async_trait::async_trait]
impl Services for StoreServices {
    async fn route(&self, server_name: &str, caller: Ipv4Addr) -> Result<Route, Denied> {
        if self.store.is_tenant_suspended(self.tenant).await {
            return Err(Denied::NotFound);
        }
        let label = server_name
            .strip_suffix(self.service_domain.as_str())
            .and_then(|rest| rest.strip_suffix('.'))
            .ok_or(Denied::NotFound)?;
        let dns = self.store.get_tenant_dns(self.tenant).await;
        let peers = self.store.get_peers(self.tenant, self.gateway).await;
        let from = peers.iter().find(|p| first_addr(p) == Some(caller)).ok_or(Denied::NotFound)?;
        let record = pick_record(&dns.records, label, from.node_id.as_i64(), from.owner.as_deref()).ok_or(Denied::NotFound)?;
        let port = record.port.ok_or(Denied::NotFound)?;
        let target = peers.iter().find(|p| p.node_id.as_i64() == record.node).and_then(first_addr).ok_or(Denied::NotFound)?;
        // The application trusts this name: it must be the owner's own,
        // never a placeholder that other members would share
        let owner = from.owner.as_deref().ok_or(Denied::NoOwner)?;
        let user = self.identity.get_tenant(self.tenant).users.get(owner).map(|u| u.login_name.clone()).ok_or(Denied::UnknownUser)?;
        Ok(Route { target: SocketAddrV4::new(target, port), user, device: from.hostname.clone() })
    }
}

impl CoordinatorState {
    /// Brings the gateway of a tenant in line with its HTTPS services. Two parts (ADR-0038):
    /// a process with a gateway offers its public keys and starts the gateway when its node exists;
    /// a control process registers the node from the offer. A relay-only process never writes nodes.
    pub async fn sync_gateway(self: &Arc<Self>, tenant: TenantId) {
        let gateways = self.gateways_cfg.get().cloned();
        if self.store.get_tenant(tenant).await.is_none() {
            if let Some(g) = &gateways {
                g.stop(tenant);
            }
            return;
        }
        let dns = self.store.get_tenant_dns(tenant).await;
        if dns.base_domain.is_none() || !dns.records.iter().any(|r| r.port.is_some()) {
            return;
        }
        let offered = match &gateways {
            Some(g) if !g.is_running(tenant) => self.offer_gateway(g, tenant).await,
            _ => false,
        };
        if self.role.serves_control() {
            self.ensure_gateway_node(tenant).await;
        }
        let Some(gateways) = gateways else { return };
        if gateways.is_running(tenant) {
            return;
        }
        match self.start_gateway(&gateways, tenant).await {
            Ok(true) => {}
            // No node yet: a control process registers it and reports the change, which runs this again.
            Ok(false) if offered && !self.role.serves_control() => {
                self.store.publish(coord_store::RemoteEvent::TenantChanged(tenant)).await;
            }
            Ok(false) => {}
            Err(e) => warn!(tenant = %tenant, error = %e, "could not start the gateway of a tailnet"),
        }
    }

    fn gateway_offer(&self, gateways: &Gateways, tenant: TenantId) -> coord_core::GatewayOffer {
        let tenant_bytes = *tenant.as_uuid().as_bytes();
        let key = |purpose| public_key(&coord_gateway::derive_key(&gateways.secret, &tenant_bytes, purpose));
        coord_core::GatewayOffer {
            node_key: key("node"),
            machine_key: key("machine"),
            // Devices need a disco key to treat the gateway as a peer.
            // The gateway answers disco only when it has direct paths.
            disco_key: coord_gateway::disco::public_key(&coord_gateway::derive_key(&gateways.secret, &tenant_bytes, "disco")),
            // Devices send to a peer through its home relay. The gateway's home relay is this process.
            region_id: self.relay_region(),
            endpoints: self.gateway_direct.as_ref().map(|d| d.endpoints.clone()).unwrap_or_default(),
        }
    }

    fn relay_region(&self) -> i32 {
        self.own_relay.as_ref().map(|r| r.region_id).unwrap_or(crate::state::BUILTIN_RELAY_REGION_ID)
    }

    /// Stores the keys of this process's gateway for `tenant`. Returns true when the stored offer is now ours.
    async fn offer_gateway(&self, gateways: &Gateways, tenant: TenantId) -> bool {
        let offer = self.gateway_offer(gateways, tenant);
        if self.store.get_gateway_offer(tenant).await.as_ref() == Some(&offer) {
            return true;
        }
        match self.store.offer_gateway(tenant, &offer).await {
            Ok(()) => true,
            Err(e) => {
                warn!(tenant = %tenant, error = %e, "could not offer the gateway of a tailnet");
                false
            }
        }
    }

    /// Control side: registers the gateway node of `tenant` from the stored offer.
    /// The offer comes from a less trusted process, so its keys must not belong to any other node.
    async fn ensure_gateway_node(self: &Arc<Self>, tenant: TenantId) {
        let Some(offer) = self.store.get_gateway_offer(tenant).await else { return };
        let by_node_key = self.store.get_node_by_node_key(&offer.node_key).await;
        let by_machine_key = self.store.get_node_by_machine_key(&offer.machine_key).await;
        let current = self.caches.gateways.get(tenant);
        // The offer is input: the type holds addresses only, and the number has a bound.
        let endpoints: Vec<String> = offer.endpoints.iter().take(coord_core::MAX_GATEWAY_ENDPOINTS).map(|e| e.to_string()).collect();
        if let (Some(node), Some(machine)) = (by_node_key, by_machine_key)
            && node == machine
            && current == Some(node.as_i64())
            && self.store.get_node_info(node).await.is_some_and(|n| n.info.endpoints == endpoints)
        {
            return; // already registered with these keys and endpoints
        }
        let nodes = self.store.list_nodes_for_tenant(tenant).await;
        for holder in [by_node_key, by_machine_key].into_iter().flatten() {
            let is_gateway_here = nodes.iter().any(|n| n.id == holder && n.attrs.owner.is_none() && n.attrs.tags.iter().any(|t| t == GATEWAY_TAG));
            if !is_gateway_here {
                error!(tenant = %tenant, node = holder.as_i64(), "gateway offer refused: its keys belong to another node");
                return;
            }
        }
        let info = NodeInfo {
            node_key: offer.node_key.to_vec(),
            machine_key: offer.machine_key.to_vec(),
            disco_key: Some(format!("discokey:{}", hex::encode(offer.disco_key))),
            endpoints,
            hostname: GATEWAY_HOSTNAME.into(),
            os: "gateway".into(),
            ipv4: None,
            ipv6: None,
        };
        let registration = NodeRegistration { owner: None, tags: vec![GATEWAY_TAG.into()], ephemeral: false, advertised_routes: None };
        let node_id = match self.store.register_node_with(tenant, offer.machine_key, info, registration).await {
            Ok((node_id, _, _)) => node_id,
            Err(e) => {
                warn!(tenant = %tenant, error = %e, "cannot register the gateway node");
                return;
            }
        };
        let _ = self.store.set_home_relay(node_id, offer.region_id).await;
        let _ = self.store.set_node_online(node_id, true).await;
        if let Err(e) = self.store.set_tenant_config(tenant, CONFIG_GATEWAY, Some(serde_json::json!({ "node_id": node_id.as_i64() }))).await {
            warn!(tenant = %tenant, error = %e, "cannot record the gateway node");
            return;
        }
        self.caches.gateways.set(tenant, node_id.as_i64());
        // A new gateway secret gives new keys and a new node. Remove the node of the old keys.
        if let Some(old) = current.filter(|old| *old != node_id.as_i64())
            && nodes.iter().any(|n| n.id.as_i64() == old && n.attrs.owner.is_none() && n.attrs.tags.iter().any(|t| t == GATEWAY_TAG))
        {
            let _ = self.store.delete_node(NodeId::new(old)).await;
        }
        info!(tenant = %tenant, node = node_id.as_i64(), "gateway node registered");
        self.notify_tenant_changed(tenant);
    }

    /// Starts the gateway when a control process has registered its node. `Ok(false)` = no node yet.
    async fn start_gateway(self: &Arc<Self>, gateways: &Arc<Gateways>, tenant: TenantId) -> Result<bool, String> {
        let service_domain = self.caches.gateways.service_domain().ok_or("no service domain (COORD_SERVICE_DOMAIN)")?.to_string();
        let tenant_bytes = *tenant.as_uuid().as_bytes();
        let node_secret = coord_gateway::derive_key(&gateways.secret, &tenant_bytes, "node");
        let node_key = public_key(&node_secret);
        let Some(node_id) = self.store.get_node_by_node_key(&node_key).await else { return Ok(false) };
        if self.store.get_node_tenant(node_id).await != Some(tenant) {
            return Ok(false);
        }
        // The netmaps name the gateway by the recorded node. Wait until that is this node.
        let recorded = self.store.get_tenant_configs(tenant).await.map_err(|e| e.to_string())?;
        let recorded = recorded.iter().find(|(kind, _)| kind == CONFIG_GATEWAY).and_then(|(_, v)| v["node_id"].as_i64());
        if recorded != Some(node_id.as_i64()) {
            return Ok(false);
        }
        let addr = self.store.get_node_ipv4(node_id).await.ok_or("the gateway node has no address")?;
        self.caches.gateways.set(tenant, node_id.as_i64());

        // The same rule as for devices: no parent link while the tenant is Closed or either side is suspended.
        let scope = crate::derp_handler::relay_scope(&self.store, tenant)
            .await
            .unwrap_or(Scope { tenant: tenant_bytes, parent: None });
        let relay = self.relay.attach_local(node_key, scope);
        let changed = Arc::new(Notify::new());
        watch_devices(self.store.subscribe(), tenant, changed.clone());
        let devices = Arc::new(StoreDevices { store: self.store.clone(), tenant, gateway: node_id, changed });
        let direct = self.gateway_direct.as_ref().map(|d| Direct {
            port: d.socket.attach(),
            disco_secret: coord_gateway::derive_key(&gateways.secret, &tenant_bytes, "disco"),
            relay_region: u16::try_from(self.relay_region()).unwrap_or(0),
        });
        let stack = Tailnet::spawn_with(node_secret, addr, relay, devices, direct);
        let services = Arc::new(StoreServices { store: self.store.clone(), identity: self.caches.identity.clone(), tenant, gateway: node_id, service_domain });
        let serving = stack.clone();
        let certificate = gateways.certificate.clone();
        tokio::spawn(async move {
            if let Err(e) = proxy::serve(serving, certificate, services).await {
                warn!(tenant = %tenant, error = %e, "the gateway of a tailnet stopped");
            }
        });
        gateways.running.lock().unwrap_or_else(|e| e.into_inner()).insert(tenant, stack);
        info!(tenant = %tenant, node = node_id.as_i64(), %addr, "gateway joined the tailnet");
        Ok(true)
    }

    /// Sets the domain of HTTPS service names (ADR-0038). Call once, before the gateways start and before any netmap.
    pub fn set_service_domain(&self, domain: String) -> bool {
        self.caches.gateways.set_service_domain(domain)
    }

    pub fn service_domain(&self) -> Option<&str> {
        self.caches.gateways.service_domain()
    }

    /// True when this deployment serves named HTTPS services: here, or on a relay process when this process is control only.
    pub fn serves_named_services(&self) -> bool {
        self.gateways().is_some() || (!self.role.serves_relay() && self.caches.gateways.service_domain().is_some())
    }

    /// Offers, registers and starts the gateways of all tenants that have HTTPS services, as far as this process's role goes.
    /// Call once at startup.
    pub async fn start_gateways(self: &Arc<Self>) {
        if self.gateways_cfg.get().is_none() {
            self.report_gateway_off().await;
            if !self.role.serves_control() {
                return;
            }
        }
        for tenant in self.store.list_tenants().await {
            self.sync_gateway(tenant.id).await;
        }
    }
}

impl CoordinatorState {
    /// Re-checks relay reach for `tenant` and its children after a posture, suspension or parent change.
    pub async fn refresh_relay_scopes(&self, tenant: TenantId) {
        let mut tenants = vec![*tenant.as_uuid().as_bytes()];
        tenants.extend(self.store.get_child_tenants(tenant).await.iter().map(|c| *c.id.as_uuid().as_bytes()));
        self.relay.rescope(Some(&tenants)).await;
    }
}

impl CoordinatorState {
    /// Warns at startup when this relay process serves no HTTPS services.
    /// Warns louder when tailnets already publish HTTPS services, because their names lead nowhere.
    async fn report_gateway_off(&self) {
        if !self.role.serves_relay() {
            return; // the gateway runs next to the relay only
        }
        let mut waiting = 0usize;
        for tenant in self.store.list_tenants().await {
            if self.store.get_tenant_dns(tenant.id).await.records.iter().any(|r| r.port.is_some()) {
                waiting += 1;
            }
        }
        if waiting > 0 {
            error!(
                tailnets = waiting,
                "GATEWAY DISABLED: tailnets publish HTTPS services but this process has no usable gateway certificate \
                 (COORD_GATEWAY_CERT / COORD_GATEWAY_KEY missing or unreadable); those service names do not work"
            );
        } else {
            warn!("gateway disabled: no usable wildcard certificate (COORD_GATEWAY_CERT / COORD_GATEWAY_KEY), so named HTTPS services are off");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(name: &str, node: i64, owner: &str, nodes: &[i64], port: u16) -> DnsRecord {
        DnsRecord { name: name.into(), node, owner: Some(owner.into()), nodes: nodes.to_vec(), port: Some(port) }
    }

    // Alice (node 10) posts a public "wiki" that Bob's laptop (node 30) is
    // connected to. Mallory (node 20) publishes a private "wiki" too.
    fn wiki() -> Vec<DnsRecord> {
        let mut records = vec![record("wiki", 20, "mallory", &[], 9999), record("wiki", 10, "alice", &[30, 21], 8080)];
        // Mallory's record sorts first: the service sorts records by name, then node.
        records.sort_by_key(|r| (r.name.clone(), r.node));
        records
    }

    #[test]
    fn a_private_record_does_not_shadow_another_members_public_service() {
        let records = wiki();
        let for_bob = pick_record(&records, "wiki", 30, Some("bob")).unwrap();
        assert_eq!((for_bob.node, for_bob.port), (10, Some(8080)), "Bob reaches Alice's wiki");
        let for_alice = pick_record(&records, "wiki", 11, Some("alice")).unwrap();
        assert_eq!(for_alice.node, 10, "Alice reaches her own wiki");
        let for_mallory = pick_record(&records, "wiki", 20, Some("mallory")).unwrap();
        assert_eq!(for_mallory.node, 20, "Mallory, not connected to Alice's post, gets only her own");
        // Mallory connected to Alice's post too: the public service wins, the same every time
        let for_connected_mallory = pick_record(&records, "wiki", 21, Some("mallory")).unwrap();
        assert_eq!(for_connected_mallory.node, 10);
        assert!(pick_record(&records, "wiki", 40, Some("carol")).is_none(), "a caller who sees neither gets nothing");
        assert!(pick_record(&records, "other", 30, Some("bob")).is_none());
    }

    #[test]
    fn records_without_a_port_are_not_https_services() {
        let mut plain = record("wiki", 10, "alice", &[], 1);
        plain.port = None;
        assert!(pick_record(&[plain], "wiki", 10, Some("alice")).is_none());
    }

    async fn tenant_with_devices() -> (Arc<Store>, TenantId, NodeId, Vec<(NodeId, Ipv4Addr)>) {
        let store = Arc::new(Store::Memory(Box::default()));
        let tenant = store.create_tenant("svc".into(), None, None).await.unwrap().id;
        let mut nodes = Vec::new();
        for (i, (owner, host)) in [(None, "gateway"), (Some("alice"), "alice-server"), (Some("bob"), "bob-laptop"), (Some("mallory"), "mallory-pc"), (None, "tagged-box")]
            .into_iter()
            .enumerate()
        {
            let key = [i as u8 + 1; 32];
            let info = NodeInfo {
                node_key: public_key(&key).to_vec(),
                machine_key: key.to_vec(),
                disco_key: None,
                endpoints: vec![],
                hostname: host.into(),
                os: "linux".into(),
                ipv4: None,
                ipv6: None,
            };
            let reg = NodeRegistration { owner: owner.map(String::from), tags: vec![], ephemeral: false, advertised_routes: None };
            let (id, addr, _) = store.register_node_with(tenant, key, info, reg).await.unwrap();
            nodes.push((id, addr));
        }
        let gateway = nodes.remove(0).0;
        (store, tenant, gateway, nodes)
    }

    #[tokio::test]
    async fn the_store_routes_by_visibility_and_refuses_unknown_identities() {
        let (store, tenant, gateway, nodes) = tenant_with_devices().await;
        let [(alice, alice_ip), (bob, bob_ip), (mallory, mallory_ip), (tagged, tagged_ip)] = nodes[..] else { panic!() };
        let id = |n: NodeId| n.as_i64();
        let dns = coord_core::TenantDns {
            base_domain: Some("ts.example.com".into()),
            records: {
                let mut r = vec![
                    record("wiki", id(mallory), "mallory", &[], 9999),
                    record("wiki", id(alice), "alice", &[id(bob), id(tagged)], 8080),
                ];
                r.sort_by_key(|r| (r.name.clone(), r.node));
                r
            },
            ..Default::default()
        };
        store.set_tenant_dns(tenant, dns).await.unwrap();
        let identity = Arc::new(IdentityRegistry::new());
        let mut known = coord_netmap::TenantIdentity::default();
        known.users.insert("alice".into(), coord_netmap::UserIdentity { login_name: "alice.example.com".into(), display_name: String::new() });
        known.users.insert("bob".into(), coord_netmap::UserIdentity { login_name: "bob.example.com".into(), display_name: String::new() });
        identity.set_tenant(tenant, known);
        let services = StoreServices { store: store.clone(), identity, tenant, gateway, service_domain: "svc.ts.example.com".into() };

        // The base domain is the control-plane namespace: the gateway does not serve it.
        assert_eq!(services.route("wiki.ts.example.com", bob_ip).await, Err(Denied::NotFound));
        let route = services.route("wiki.svc.ts.example.com", bob_ip).await.unwrap();
        assert_eq!(route.target, SocketAddrV4::new(alice_ip, 8080), "Mallory's private record does not shadow Alice's service");
        assert_eq!(route.user, "bob.example.com");
        assert_eq!(route.device, "bob-laptop");

        // Mallory sees her own record, but her name is unknown. No shared placeholder: a refusal.
        assert_eq!(services.route("wiki.svc.ts.example.com", mallory_ip).await, Err(Denied::UnknownUser));
        // A device without an owner has no member identity at all
        assert_eq!(services.route("wiki.svc.ts.example.com", tagged_ip).await, Err(Denied::NoOwner));
        assert_eq!(services.route("nothing.svc.ts.example.com", bob_ip).await, Err(Denied::NotFound));
        assert_eq!(services.route("wiki.other.example", bob_ip).await, Err(Denied::NotFound));

        store.set_tenant_suspended(tenant, true).await.unwrap();
        assert_eq!(services.route("wiki.svc.ts.example.com", bob_ip).await, Err(Denied::NotFound));
    }

    #[tokio::test]
    async fn a_node_change_in_the_tenant_wakes_the_device_cache() {
        let (store, tenant, gateway, nodes) = tenant_with_devices().await;
        let changed = Arc::new(Notify::new());
        watch_devices(store.subscribe(), tenant, changed.clone());
        let other = store.create_tenant("other".into(), None, None).await.unwrap().id;
        let _ = store.delete_nodes_by_owner(other, "nobody").await;
        assert!(tokio::time::timeout(std::time::Duration::from_millis(100), changed.notified()).await.is_err(), "nothing changed in this tenant");
        let _ = gateway;
        store.delete_node(nodes[1].0).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), changed.notified()).await.expect("removing a device invalidates the cache");
    }
}
