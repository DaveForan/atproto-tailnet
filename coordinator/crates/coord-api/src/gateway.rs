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

use coord_core::{NodeId, NodeInfo, NodeRegistration, PeerInfo, TenantId};
use coord_derp::Scope;
use coord_gateway::netstack::NetStack;
use coord_gateway::proxy::{self, Certificate, Route, Services};
use coord_gateway::tunnel::{public_key, Devices, Tailnet};
use coord_netmap::IdentityRegistry;
use coord_store::Store;
use tracing::{info, warn};

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
}

#[async_trait::async_trait]
impl Devices for StoreDevices {
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

#[async_trait::async_trait]
impl Services for StoreServices {
    async fn route(&self, server_name: &str, caller: Ipv4Addr) -> Option<Route> {
        if self.store.is_tenant_suspended(self.tenant).await {
            return None;
        }
        let dns = self.store.get_tenant_dns(self.tenant).await;
        let label = server_name.strip_suffix(dns.base_domain.as_deref()?)?.strip_suffix('.')?;
        let record = dns.records.iter().find(|r| r.name == label && r.port.is_some())?;
        let peers = self.store.get_peers(self.tenant, self.gateway).await;
        let from = peers.iter().find(|p| first_addr(p) == Some(caller))?;
        // The same rule that decides who gets the DNS record
        if !record.visible_to(from.node_id.as_i64(), from.owner.as_deref()) {
            return None;
        }
        let target = peers.iter().find(|p| p.node_id.as_i64() == record.node).and_then(first_addr)?;
        Some(Route {
            target: SocketAddrV4::new(target, record.port?),
            user: self.identity.profile(self.tenant, from.owner.as_deref()).login_name,
            device: from.hostname.clone(),
        })
    }
}

impl CoordinatorState {
    /// Start the gateway of a tenant when the tenant has an HTTPS service and
    /// its gateway is not running here. Does nothing when this process has no
    /// gateway configuration.
    pub async fn sync_gateway(self: &Arc<Self>, tenant: TenantId) {
        let Some(gateways) = self.gateways_cfg.clone() else { return };
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
        let devices = Arc::new(StoreDevices { store: self.store.clone(), tenant, gateway: node_id });
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
        if self.gateways_cfg.is_none() {
            return;
        }
        for tenant in self.store.list_tenants().await {
            self.sync_gateway(tenant.id).await;
        }
    }
}
