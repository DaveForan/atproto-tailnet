//! The gateway inside the coordinator (ADR-0029, ADR-0030).
//!
//! When a tailnet has an HTTPS service, the coordinator puts a gateway node
//! in it: a tagged node with no owner, registered directly (no auth key),
//! attached to the built-in relay in this process. The gateway answers two
//! questions from the store: which device has this key or address, and which
//! service may this caller use.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddrV4};
use std::sync::{Arc, Mutex};

use coord_core::{DnsRecord, NodeId, NodeInfo, NodeRegistration, PeerInfo, TenantId};
use coord_derp::Scope;
use coord_gateway::netstack::NetStack;
use coord_gateway::proxy::{self, Certificate, Denied, Route, Services};
use coord_gateway::tunnel::{public_key, Devices, Tailnet};
use coord_netmap::IdentityRegistry;
use coord_store::{PeerEvent, Store};
use tokio::sync::{broadcast, Notify};
use tracing::{error, info, warn};

use crate::state::{CoordinatorState, CONFIG_GATEWAY};

pub const GATEWAY_TAG: &str = "tag:gateway";
pub const GATEWAY_HOSTNAME: &str = "gateway";

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
}

/// The HTTPS services of one tenant: the DNS records that have a port.
struct StoreServices {
    store: Arc<Store>,
    identity: Arc<IdentityRegistry>,
    tenant: TenantId,
    gateway: NodeId,
}

/// The HTTPS service record named `label` that this caller may use.
///
/// Several records can have one name: a private-board name is unique only
/// for its author, a public one in the tailnet. Only records that the caller
/// may see count (the same rule that decides who gets the DNS record), so a
/// member's private record cannot hide another member's public service.
/// Among visible records the order is fixed: a public record (open to
/// devices beyond the author's, or to everyone) before a private one, then
/// one that names the calling device, then the lowest node and port.
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
        let dns = self.store.get_tenant_dns(self.tenant).await;
        let label = dns
            .base_domain
            .as_deref()
            .and_then(|base| server_name.strip_suffix(base))
            .and_then(|rest| rest.strip_suffix('.'))
            .ok_or(Denied::NotFound)?;
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
    /// Start the gateway of a tenant when the tenant has an HTTPS service and
    /// its gateway is not running here. Does nothing when this process has no
    /// gateway configuration.
    pub async fn sync_gateway(self: &Arc<Self>, tenant: TenantId) {
        let Some(gateways) = self.gateways_cfg.get().cloned() else { return };
        if self.store.get_tenant(tenant).await.is_none() {
            gateways.stop(tenant);
            return;
        }
        if gateways.is_running(tenant) {
            return;
        }
        let dns = self.store.get_tenant_dns(tenant).await;
        if dns.base_domain.is_none() || !dns.records.iter().any(|r| r.port.is_some()) {
            return;
        }
        if let Err(e) = self.start_gateway(&gateways, tenant).await {
            warn!(tenant = %tenant, error = %e, "could not start the gateway of a tailnet");
        }
    }

    async fn start_gateway(self: &Arc<Self>, gateways: &Arc<Gateways>, tenant: TenantId) -> Result<(), String> {
        let tenant_row = self.store.get_tenant(tenant).await.ok_or("tenant not found")?;
        let tenant_bytes = *tenant.as_uuid().as_bytes();
        let node_secret = coord_gateway::derive_key(&gateways.secret, &tenant_bytes, "node");
        let node_key = public_key(&node_secret);
        let machine_key = public_key(&coord_gateway::derive_key(&gateways.secret, &tenant_bytes, "machine"));
        // Devices need a disco key to treat the gateway as a peer. The
        // gateway does not answer disco, so they reach it through the relay.
        let disco_key = public_key(&coord_gateway::derive_key(&gateways.secret, &tenant_bytes, "disco"));

        let info = NodeInfo {
            node_key: node_key.to_vec(),
            machine_key: machine_key.to_vec(),
            disco_key: Some(format!("discokey:{}", hex::encode(disco_key))),
            endpoints: vec![],
            hostname: GATEWAY_HOSTNAME.into(),
            os: "gateway".into(),
            ipv4: None,
            ipv6: None,
        };
        let registration = NodeRegistration { owner: None, tags: vec![GATEWAY_TAG.into()], ephemeral: false, advertised_routes: None };
        let (node_id, addr, _) = self
            .store
            .register_node_with(tenant, machine_key, info, registration)
            .await
            .map_err(|e| format!("cannot register the gateway node: {e}"))?;
        // Devices send to a peer through its home relay: ours is this process
        let region = self.own_relay.as_ref().map(|r| r.region_id).unwrap_or(crate::state::BUILTIN_RELAY_REGION_ID);
        let _ = self.store.set_home_relay(node_id, region).await;
        let _ = self.store.set_node_online(node_id, true).await;
        self.store
            .set_tenant_config(tenant, CONFIG_GATEWAY, Some(serde_json::json!({ "node_id": node_id.as_i64() })))
            .await
            .map_err(|e| format!("cannot record the gateway node: {e}"))?;
        self.gateway_nodes.set(tenant, node_id.as_i64());

        let scope = Scope { tenant: tenant_bytes, parent: tenant_row.parent_id.map(|p| *p.as_uuid().as_bytes()) };
        let relay = self.relay.attach_local(node_key, scope);
        let changed = Arc::new(Notify::new());
        watch_devices(self.store.subscribe(), tenant, changed.clone());
        let devices = Arc::new(StoreDevices { store: self.store.clone(), tenant, gateway: node_id, changed });
        let stack = Tailnet::spawn(node_secret, addr, relay, devices);
        let services = Arc::new(StoreServices { store: self.store.clone(), identity: self.identity.clone(), tenant, gateway: node_id });
        let serving = stack.clone();
        let certificate = gateways.certificate.clone();
        tokio::spawn(async move {
            if let Err(e) = proxy::serve(serving, certificate, services).await {
                warn!(tenant = %tenant, error = %e, "the gateway of a tailnet stopped");
            }
        });
        gateways.running.lock().unwrap_or_else(|e| e.into_inner()).insert(tenant, stack);
        info!(tenant = %tenant, node = node_id.as_i64(), %addr, "gateway joined the tailnet");
        // Devices learn about the new peer and the service addresses
        self.notify_tenant_changed(tenant);
        Ok(())
    }

    /// Start the gateways of all tenants that have HTTPS services. Call once at startup.
    pub async fn start_gateways(self: &Arc<Self>) {
        if self.gateways_cfg.get().is_none() {
            self.report_gateway_off().await;
            return;
        }
        for tenant in self.store.list_tenants().await {
            self.sync_gateway(tenant.id).await;
        }
    }
}

impl CoordinatorState {
    /// Say clearly at startup that this process serves no HTTPS services,
    /// when it is the process that should (it runs the relay). Louder when
    /// tailnets already publish HTTPS services: their names then lead
    /// nowhere.
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
        // Mallory's record sorts first, as the service sorts records by name, then node
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
        let services = StoreServices { store: store.clone(), identity, tenant, gateway };

        let route = services.route("wiki.ts.example.com", bob_ip).await.unwrap();
        assert_eq!(route.target, SocketAddrV4::new(alice_ip, 8080), "Mallory's private record does not shadow Alice's service");
        assert_eq!(route.user, "bob.example.com");
        assert_eq!(route.device, "bob-laptop");

        // Mallory sees her own record, but the coordinator does not know her name:
        // no shared placeholder identity, a refusal
        assert_eq!(services.route("wiki.ts.example.com", mallory_ip).await, Err(Denied::UnknownUser));
        // A device without an owner has no member identity at all
        assert_eq!(services.route("wiki.ts.example.com", tagged_ip).await, Err(Denied::NoOwner));
        assert_eq!(services.route("nothing.ts.example.com", bob_ip).await, Err(Denied::NotFound));
        assert_eq!(services.route("wiki.other.example", bob_ip).await, Err(Denied::NotFound));

        store.set_tenant_suspended(tenant, true).await.unwrap();
        assert_eq!(services.route("wiki.ts.example.com", bob_ip).await, Err(Denied::NotFound));
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
