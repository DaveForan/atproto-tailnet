use std::sync::Arc;
use tracing::{info, warn};

use coord_core::NodeInfo;
use coord_proto::register::{RegisterRequest, RegisterResponse, User, Login};
use coord_proto::map::MapRequest;
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
                warn!(auth_key_prefix = &key[..key.len().min(12)], "invalid pre-auth key");
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
                if let Err(e) = state.store.rotate_node_key(machine_key, &old_key, &node_key_bytes).await {
                    tracing::warn!(error = %e, "rotate_node_key failed");
                }
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

    if let Some(node_id) = state.store.get_node_by_machine_key(machine_key).await {
        if req.endpoints.is_some() || req.disco_key.is_some() {
            if let Err(e) = state.store.update_endpoints(
                node_id,
                req.endpoints.clone().unwrap_or_default(),
                req.disco_key.clone(),
            ).await {
                tracing::warn!(error = %e, "update_endpoints failed");
            }
        }
    }

    build_map_snapshot(state, machine_key).await
}

pub async fn build_map_snapshot(
    state: &Arc<CoordinatorState>,
    machine_key: &[u8; 32],
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let resp = state.netmap.build_snapshot(machine_key).await?;
    Ok(serde_json::to_string(&resp)?)
}

pub async fn build_delta_response(
    state: &Arc<CoordinatorState>,
    _machine_key: &[u8; 32],
    event: &PeerEvent,
) -> Option<String> {
    let resp = state.netmap.build_delta(event).await?;
    serde_json::to_string(&resp).ok()
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
