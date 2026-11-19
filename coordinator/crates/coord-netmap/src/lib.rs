use std::sync::Arc;

use coord_acl::AclEngine;
use coord_acl::PolicyEngine;
use std::collections::HashMap;
use std::sync::RwLock;

use coord_core::keys::{format_machine_key, format_node_key};
use coord_core::{MachineKey, TenantId};
use coord_proto::map::{DerpMap, DerpRegion, DnsConfig, MapNode, MapResponse, UserProfile};
use coord_store::{PeerEvent, Store};

#[derive(Debug, Clone)]
pub struct TenantDerp {
    pub custom_regions: HashMap<i32, DerpRegion>,
    pub include_default: bool,
}

/// Operator-wide default DERP map plus per-tenant overrides.
pub struct DerpRegistry {
    default: DerpMap,
    tenants: RwLock<HashMap<TenantId, TenantDerp>>,
}

impl DerpRegistry {
    pub fn new(default: DerpMap) -> Self {
        Self { default, tenants: RwLock::new(HashMap::new()) }
    }

    pub fn default_map(&self) -> &DerpMap {
        &self.default
    }

    pub fn set_tenant(&self, tenant: TenantId, cfg: TenantDerp) {
        self.tenants.write().unwrap_or_else(|e| e.into_inner()).insert(tenant, cfg);
    }

    pub fn get_tenant(&self, tenant: TenantId) -> Option<TenantDerp> {
        self.tenants.read().unwrap_or_else(|e| e.into_inner()).get(&tenant).cloned()
    }

    pub fn remove_tenant(&self, tenant: TenantId) {
        self.tenants.write().unwrap_or_else(|e| e.into_inner()).remove(&tenant);
    }

    pub fn map_for(&self, tenant: TenantId) -> DerpMap {
        let Some(cfg) = self.get_tenant(tenant) else {
            return self.default.clone();
        };
        let mut regions = if cfg.include_default {
            self.default.regions.clone()
        } else {
            HashMap::new()
        };
        regions.extend(cfg.custom_regions);
        DerpMap { regions, omit_default_regions: Some(true) }
    }
}

pub struct NetmapService {
    store: Arc<Store>,
    acl: Arc<PolicyEngine>,
    derp: Arc<DerpRegistry>,
}

impl NetmapService {
    pub fn new(store: Arc<Store>, acl: Arc<PolicyEngine>, derp: Arc<DerpRegistry>) -> Self {
        Self { store, acl, derp }
    }

    pub async fn build_snapshot(
        &self,
        machine_key: &[u8; 32],
    ) -> Result<MapResponse, Box<dyn std::error::Error + Send + Sync>> {
        let node_id = self
            .store
            .get_node_by_machine_key(machine_key)
            .await
            .ok_or("node not registered")?;

        let detail = self
            .store
            .get_node_info(node_id)
            .await
            .ok_or("node info not found")?;

        let tenant_id = detail.tenant_id;
        let ipv4 = detail.ipv4;

        let node_key_str = format_key_bytes(&detail.info.node_key);

        let children = self.store.get_child_tenants(tenant_id).await;
        let peers = if children.is_empty() {
            self.store.get_peers(tenant_id, node_id).await
        } else {
            self.store.get_peers_with_children(tenant_id, node_id).await
        };
        let derp_map = self.derp.map_for(tenant_id);
        let home_region = derp_map.regions.keys().min().copied().unwrap_or(1);
        let peer_nodes: Vec<MapNode> = peers
            .iter()
            .map(|p| peer_info_to_map_node(p, home_region))
            .collect();

        let self_node = MapNode {
            id: node_id.as_i64(),
            stable_id: detail.stable_id,
            name: format!("node-{}.mesh.local.", node_id.as_i64()),
            user: 1,
            key: node_key_str,
            machine: format_machine_key(&MachineKey(*machine_key)),
            disco_key: None,
            addresses: vec![format!("{}/32", ipv4)],
            allowed_ips: vec![format!("{}/32", ipv4)],
            endpoints: vec![],
            derp: Some(format!("127.3.3.40:{}", home_region)),
            home_derp: Some(home_region),
            hostinfo: None,
            online: Some(true),
            last_seen: None,
            machine_authorized: Some(true),
            key_expiry: None,
        };

        Ok(MapResponse {
            node: Some(self_node),
            peers: if peer_nodes.is_empty() {
                None
            } else {
                Some(peer_nodes)
            },
            peers_changed: None,
            peers_removed: None,
            derp_map: Some(derp_map),
            dns_config: Some(DnsConfig {
                resolvers: Some(vec![]),
                domains: Some(vec![]),
                routes: None,
            }),
            packet_filter: Some(
                self.acl
                    .filter_rules_for_node(tenant_id, node_id, &ipv4.to_string()),
            ),
            domain: Some("mesh.local".into()),
            user_profiles: Some(vec![UserProfile {
                id: 1,
                login_name: "mesh@coordinator.local".into(),
                display_name: "Mesh User".into(),
            }]),
            keep_alive: None,
            control_time: Some(chrono::Utc::now().to_rfc3339()),
        })
    }

    pub async fn build_delta(&self, event: &PeerEvent) -> Option<MapResponse> {
        match event {
            PeerEvent::NodeJoined { node_id, .. } | PeerEvent::NodeUpdated { node_id, .. } => {
                let detail = self.store.get_node_info(*node_id).await?;
                let node_key = format_key_bytes(&detail.info.node_key);
                let machine_key_str = if detail.info.machine_key.len() == 32 {
                    let mut mk = [0u8; 32];
                    mk.copy_from_slice(&detail.info.machine_key);
                    format_machine_key(&MachineKey(mk))
                } else {
                    String::new()
                };

                let home_region = self
                    .derp
                    .map_for(detail.tenant_id)
                    .regions
                    .keys()
                    .min()
                    .copied()
                    .unwrap_or(1);
                let peer = MapNode {
                    id: node_id.as_i64(),
                    stable_id: format!("peer-{}", node_id.as_i64()),
                    name: format!("{}.mesh.local.", detail.info.hostname),
                    user: 1,
                    key: node_key,
                    machine: machine_key_str,
                    disco_key: detail.info.disco_key.clone(),
                    addresses: vec![format!("{}/32", detail.ipv4)],
                    allowed_ips: vec![format!("{}/32", detail.ipv4)],
                    endpoints: detail.info.endpoints.clone(),
                    derp: Some(format!("127.3.3.40:{}", home_region)),
                    home_derp: Some(home_region),
                    hostinfo: None,
                    online: Some(detail.online),
                    last_seen: None,
                    machine_authorized: Some(true),
                    key_expiry: None,
                };

                Some(MapResponse {
                    peers_changed: Some(vec![peer]),
                    control_time: Some(chrono::Utc::now().to_rfc3339()),
                    ..Default::default()
                })
            }
            PeerEvent::NodeOffline { node_id, .. } => Some(MapResponse {
                peers_removed: Some(vec![node_id.as_i64()]),
                control_time: Some(chrono::Utc::now().to_rfc3339()),
                ..Default::default()
            }),
        }
    }
}

fn format_key_bytes(key: &[u8]) -> String {
    if key.len() == 32 {
        let mut k = [0u8; 32];
        k.copy_from_slice(key);
        format_node_key(&k)
    } else {
        hex::encode(key)
    }
}

fn peer_info_to_map_node(p: &coord_core::PeerInfo, home_region: i32) -> MapNode {
    let peer_key = format_key_bytes(&p.node_key);
    let machine_key_str = if p.machine_key.len() == 32 {
        format_machine_key(&MachineKey(p.machine_key.clone().try_into().unwrap()))
    } else {
        String::new()
    };
    // Stores don't track a peer's real home DERP yet; use the tenant map's home region.
    let derp_region = home_region;

    MapNode {
        id: p.node_id.as_i64(),
        stable_id: format!("peer-{}", p.node_id.as_i64()),
        name: format!("{}.mesh.local.", p.hostname),
        user: 1,
        key: peer_key,
        machine: machine_key_str,
        disco_key: p.disco_key.clone(),
        addresses: p.allowed_ips.clone(),
        allowed_ips: p.allowed_ips.clone(),
        endpoints: p.endpoints.clone(),
        derp: Some(format!("127.3.3.40:{}", derp_region)),
        home_derp: Some(derp_region),
        hostinfo: None,
        online: Some(p.online),
        last_seen: p.last_seen.map(|t| t.to_rfc3339()),
        machine_authorized: Some(true),
        key_expiry: None,
    }
}
