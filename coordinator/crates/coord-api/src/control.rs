use std::sync::Arc;
use tracing::{info, warn};

use coord_core::NodeInfo;
use coord_core::keys::{format_machine_key, format_node_key};
use coord_proto::register::{RegisterRequest, RegisterResponse, User, Login};
use coord_proto::map::{
    MapRequest, MapResponse, MapNode, DnsConfig, UserProfile,
};
use coord_store::PeerEvent;

use crate::state::CoordinatorState;

pub async fn handle_register(
    state: &Arc<CoordinatorState>,
    machine_key: &[u8; 32],
    body: &str,
) -> Result<(String, Option<u64>), Box<dyn std::error::Error + Send + Sync>> {
    let req: RegisterRequest = serde_json::from_str(body)?;

    let auth_key = req
        .auth
        .as_ref()
        .and_then(|a| a.auth_key.as_deref());

    let tenant_id = match auth_key {
        Some(key) => match state.store.validate_preauth_key(key).await {
            Some(tid) => tid,
            None => {
                warn!(auth_key = key, "invalid pre-auth key");
                let resp = RegisterResponse {
                    user: User::default(),
                    login: Login::default(),
                    node_key_expired: false,
                    machine_authorized: false,
                    auth_url: String::new(),
                    error: "invalid or expired pre-auth key".into(),
                };
                return Ok((serde_json::to_string(&resp)?, None));
            }
        },
        None => {
            let resp = RegisterResponse {
                user: User::default(),
                login: Login::default(),
                node_key_expired: false,
                machine_authorized: false,
                auth_url: "https://example.com/register".into(),
                error: String::new(),
            };
            return Ok((serde_json::to_string(&resp)?, None));
        }
    };

    let node_key_bytes = parse_key_from_request(&req.node_key)?;

    if let Some(ref old_key_str) = req.old_node_key {
        if let Ok(old_key) = parse_key_from_request(old_key_str) {
            if old_key != [0u8; 32] {
                state.store.rotate_node_key(machine_key, &old_key, &node_key_bytes).await;
                info!(
                    old_key = hex::encode(&old_key[..8]),
                    new_key = hex::encode(&node_key_bytes[..8]),
                    "node key rotated"
                );
            }
        }
    }

    let node_info = NodeInfo {
        node_key: node_key_bytes.to_vec(),
        machine_key: machine_key.to_vec(),
        disco_key: None,
        endpoints: vec![],
        hostname: req
            .hostinfo
            .as_ref()
            .and_then(|h| h.hostname.clone())
            .unwrap_or_else(|| "unknown".into()),
        os: req
            .hostinfo
            .as_ref()
            .and_then(|h| h.os.clone())
            .unwrap_or_else(|| "unknown".into()),
        ipv4: None,
        ipv6: None,
    };

    let (node_id, ipv4, generation) = state.store.register_node(tenant_id, *machine_key, node_info).await?;

    info!(
        node_id = node_id.as_i64(),
        ipv4 = %ipv4,
        hostname = req.hostinfo.as_ref().and_then(|h| h.hostname.as_deref()).unwrap_or("unknown"),
        "node registered"
    );

    let resp = RegisterResponse {
        user: User {
            id: 1,
            display_name: "Mesh User".into(),
        },
        login: Login {
            id: 1,
            provider: "coordinator".into(),
            login_name: "mesh@coordinator.local".into(),
            display_name: "Mesh User".into(),
        },
        node_key_expired: false,
        machine_authorized: true,
        auth_url: String::new(),
        error: String::new(),
    };

    Ok((serde_json::to_string(&resp)?, Some(generation)))
}

pub async fn handle_map(
    state: &Arc<CoordinatorState>,
    machine_key: &[u8; 32],
    body: &str,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let req: MapRequest = serde_json::from_str(body)?;

    if req.keep_alive == Some(true) {
        let resp = MapResponse {
            keep_alive: Some(true),
            ..Default::default()
        };
        return Ok(serde_json::to_string(&resp)?);
    }

    if let Some(node_id) = state.store.get_node_by_machine_key(machine_key).await {
        if req.endpoints.is_some() || req.disco_key.is_some() {
            state.store.update_endpoints(
                node_id,
                req.endpoints.clone().unwrap_or_default(),
                req.disco_key.clone(),
            ).await;
        }
    }

    build_map_snapshot(state, machine_key).await
}

/// Build a full MapResponse from current store state without processing
/// any request body. Used for initial map responses and lag recovery.
pub async fn build_map_snapshot(
    state: &Arc<CoordinatorState>,
    machine_key: &[u8; 32],
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let node_id = state
        .store
        .get_node_by_machine_key(machine_key).await
        .ok_or("node not registered")?;

    let tenant_id = state
        .store
        .get_node_tenant(node_id).await
        .ok_or("node has no tenant")?;

    let ipv4 = state
        .store
        .get_node_ipv4(node_id).await
        .ok_or("node has no IP")?;

    let (_, _, stable_id, node_info) = state
        .store
        .get_node_info(node_id).await
        .ok_or("node info not found")?;

    let node_key_str = if node_info.node_key.len() == 32 {
        let mut k = [0u8; 32];
        k.copy_from_slice(&node_info.node_key);
        format_node_key(&k)
    } else {
        hex::encode(&node_info.node_key)
    };

    let children = state.store.get_child_tenants(tenant_id).await;
    let peers = if children.is_empty() {
        state.store.get_peers(tenant_id, node_id).await
    } else {
        state.store.get_peers_with_children(tenant_id, node_id).await
    };
    let peer_nodes: Vec<MapNode> = peers
        .iter()
        .map(|p| peer_info_to_map_node(p))
        .collect();

    let home_region = state.derp_map.regions.keys().min().copied().unwrap_or(1);

    let self_node = MapNode {
        id: node_id.as_i64(),
        stable_id,
        name: format!("node-{}.mesh.local.", node_id.as_i64()),
        user: 1,
        key: node_key_str,
        machine: format_machine_key(&coord_core::MachineKey(*machine_key)),
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

    let resp = MapResponse {
        node: Some(self_node),
        peers: if peer_nodes.is_empty() {
            None
        } else {
            Some(peer_nodes)
        },
        peers_changed: None,
        peers_removed: None,
        derp_map: Some(state.derp_map.clone()),
        dns_config: Some(DnsConfig {
            resolvers: Some(vec![]),
            domains: Some(vec![]),
            routes: None,
        }),
        packet_filter: Some({
            use coord_acl::AclEngine;
            state.acl.filter_rules_for_node(tenant_id, node_id, &ipv4.to_string())
        }),
        domain: Some("mesh.local".into()),
        user_profiles: Some(vec![UserProfile {
            id: 1,
            login_name: "mesh@coordinator.local".into(),
            display_name: "Mesh User".into(),
        }]),
        keep_alive: None,
        control_time: Some(chrono::Utc::now().to_rfc3339()),
    };

    Ok(serde_json::to_string(&resp)?)
}

/// Build a delta MapResponse for a peer event.
/// Returns None if the event doesn't produce a meaningful delta.
pub async fn build_delta_response(
    state: &Arc<CoordinatorState>,
    _machine_key: &[u8; 32],
    event: &PeerEvent,
) -> Option<String> {
    match event {
        PeerEvent::NodeJoined { node_id, .. } | PeerEvent::NodeUpdated { node_id, .. } => {
            let (_, ipv4, stable_id, info) = state.store.get_node_info(*node_id).await?;
            let node_key = if info.node_key.len() == 32 {
                let mut k = [0u8; 32];
                k.copy_from_slice(&info.node_key);
                format_node_key(&k)
            } else {
                hex::encode(&info.node_key)
            };

            let home_region = state.derp_map.regions.keys().min().copied().unwrap_or(1);
            let peer = MapNode {
                id: node_id.as_i64(),
                stable_id,
                name: format!("{}.mesh.local.", info.hostname),
                user: 1,
                key: node_key,
                machine: String::new(),
                disco_key: info.disco_key.clone(),
                addresses: vec![format!("{}/32", ipv4)],
                allowed_ips: vec![format!("{}/32", ipv4)],
                endpoints: info.endpoints.clone(),
                derp: Some(format!("127.3.3.40:{}", home_region)),
                home_derp: Some(home_region),
                hostinfo: None,
                online: Some(true),
                last_seen: None,
                machine_authorized: Some(true),
                key_expiry: None,
            };

            let resp = MapResponse {
                peers_changed: Some(vec![peer]),
                control_time: Some(chrono::Utc::now().to_rfc3339()),
                ..Default::default()
            };

            Some(serde_json::to_string(&resp).ok()?)
        }
        PeerEvent::NodeOffline { node_id, .. } => {
            let resp = MapResponse {
                peers_removed: Some(vec![node_id.as_i64()]),
                control_time: Some(chrono::Utc::now().to_rfc3339()),
                ..Default::default()
            };

            Some(serde_json::to_string(&resp).ok()?)
        }
    }
}

fn peer_info_to_map_node(p: &coord_core::PeerInfo) -> MapNode {
    let peer_key = if p.node_key.len() == 32 {
        let mut k = [0u8; 32];
        k.copy_from_slice(&p.node_key);
        format_node_key(&k)
    } else {
        hex::encode(&p.node_key)
    };

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

fn parse_key_from_request(key_str: &str) -> Result<[u8; 32], Box<dyn std::error::Error + Send + Sync>> {
    let hex_str = key_str
        .strip_prefix("nodekey:")
        .or_else(|| key_str.strip_prefix("mkey:"))
        .unwrap_or(key_str);

    let bytes = hex::decode(hex_str)?;
    if bytes.len() != 32 {
        return Err(format!("key must be 32 bytes, got {}", bytes.len()).into());
    }
    let mut result = [0u8; 32];
    result.copy_from_slice(&bytes);
    Ok(result)
}
