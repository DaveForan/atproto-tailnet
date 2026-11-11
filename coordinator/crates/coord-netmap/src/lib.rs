use std::sync::Arc;

use coord_acl::AclEngine;
use coord_acl::PolicyEngine;
use coord_core::keys::{format_machine_key, format_node_key};
use coord_core::MachineKey;
use coord_proto::map::{DerpMap, DnsConfig, MapNode, MapResponse, UserProfile};
use coord_store::{PeerEvent, Store};

pub struct NetmapService {
    store: Arc<Store>,
    acl: Arc<PolicyEngine>,
    derp_map: DerpMap,
}

impl NetmapService {
    pub fn new(store: Arc<Store>, acl: Arc<PolicyEngine>, derp_map: DerpMap) -> Self {
        Self { store, acl, derp_map }
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
        let peer_nodes: Vec<MapNode> = peers.iter().map(peer_info_to_map_node).collect();

        let home_region = self.derp_map.regions.keys().min().copied().unwrap_or(1);

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
            derp_map: Some(self.derp_map.clone()),
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

                let home_region = self.derp_map.regions.keys().min().copied().unwrap_or(1);
                let peer = MapNode {
                    id: node_id.as_i64(),
                    stable_id: detail.stable_id,
                    name: format!("{}.mesh.local.", detail.info.hostname),
                    user: 1,
                    key: node_key,
                    machine: String::new(),
                    disco_key: detail.info.disco_key.clone(),
                    addresses: vec![format!("{}/32", detail.ipv4)],
                    allowed_ips: vec![format!("{}/32", detail.ipv4)],
                    endpoints: detail.info.endpoints.clone(),
                    derp: Some(format!("127.3.3.40:{}", home_region)),
                    home_derp: Some(home_region),
                    hostinfo: None,
                    online: Some(true),
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

fn peer_info_to_map_node(p: &coord_core::PeerInfo) -> MapNode {
    let peer_key = format_key_bytes(&p.node_key);
    let derp_region = p.derp_region.unwrap_or(1);

    MapNode {
        id: p.node_id.as_i64(),
        stable_id: format!("peer-{}", p.node_id.as_i64()),
        name: p.hostname.clone(),
        user: 1,
        key: peer_key,
        machine: String::new(),
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
