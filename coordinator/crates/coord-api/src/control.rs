use std::sync::Arc;
use tracing::{info, warn};

use coord_core::{NodeId, NodeInfo, NodeRegistration};
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

    let node_key_bytes = parse_key_from_request(&req.node_key)?;
    let advertised = advertised_routes_from(req.hostinfo.as_ref());

    // A known machine re-registering with its current (or rotated-from) node key
    // is already authorized; tailscaled does this on every restart without an auth key.
    if let Some(existing) = state.store.get_node_by_machine_key(machine_key).await {
        if let Some(detail) = state.store.get_node_info(existing).await {
            let old_key = req
                .old_node_key
                .as_deref()
                .and_then(|k| parse_key_from_request(k).ok())
                .filter(|k| *k != [0u8; 32]);
            let current = detail.info.node_key.as_slice();
            if current == node_key_bytes.as_slice() {
                sync_node_routes(state, existing, advertised).await;
                return Ok((serde_json::to_string(&authorized_response())?, None));
            }
            if let Some(old) = old_key.filter(|k| current == k.as_slice()) {
                state.store.rotate_node_key(machine_key, &old, &node_key_bytes).await?;
                info!(node_id = existing.as_i64(), "node key rotated on re-register");
                sync_node_routes(state, existing, advertised).await;
                return Ok((serde_json::to_string(&authorized_response())?, None));
            }
        }
    }

    let grant = match auth_key {
        Some(key) => match state.store.validate_preauth_key(key).await {
            Some(grant) => grant,
            None => {
                let prefix: String = key.chars().take(12).collect();
                warn!(auth_key_prefix = %prefix, "invalid pre-auth key");
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

    let tenant_id = grant.tenant_id;
    let registration = NodeRegistration {
        owner: grant.owner,
        tags: grant.tags,
        ephemeral: grant.ephemeral,
        advertised_routes: advertised,
    };
    let (node_id, ipv4, generation) = state
        .store
        .register_node_with(tenant_id, *machine_key, node_info, registration)
        .await?;
    // Advertised routes were stored with the node; apply auto-approvers now.
    sync_node_routes(state, node_id, None).await;

    info!(
        node_id = node_id.as_i64(),
        ipv4 = %ipv4,
        hostname = req.hostinfo.as_ref().and_then(|h| h.hostname.as_deref()).unwrap_or("unknown"),
        "node registered"
    );

    Ok((serde_json::to_string(&authorized_response())?, Some(generation)))
}

fn authorized_response() -> RegisterResponse {
    RegisterResponse {
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
    }
}

pub async fn handle_map(
    state: &Arc<CoordinatorState>,
    machine_key: &[u8; 32],
    body: &str,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let req: MapRequest = serde_json::from_str(body)?;

    if let Some(node_id) = state.store.get_node_by_machine_key(machine_key).await {
        if req.hostinfo.is_some() {
            sync_node_routes(state, node_id, advertised_routes_from(req.hostinfo.as_ref())).await;
        }
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

/// Normalised advertised routes from a client's Hostinfo. `None` when the request
/// carried no Hostinfo (leave stored routes alone); a Hostinfo without
/// RoutableIPs means "advertises nothing".
fn advertised_routes_from(hostinfo: Option<&coord_proto::register::Hostinfo>) -> Option<Vec<String>> {
    hostinfo.map(|h| coord_core::routes::normalize_routes_lossy(h.routable_ips.as_deref().unwrap_or(&[])))
}

/// Persist a node's advertised routes (if given), apply the tenant's
/// auto-approvers, and push a fresh netmap to the tenant if anything changed.
/// Nodes can only *advertise*; approval comes from the admin API or auto-approvers.
pub(crate) async fn sync_node_routes(
    state: &Arc<CoordinatorState>,
    node_id: NodeId,
    advertised: Option<Vec<String>>,
) {
    let Some(before) = state.store.get_node_info(node_id).await else {
        return;
    };
    let mut changed = false;
    if let Some(routes) = advertised {
        match state.store.set_advertised_routes(node_id, routes).await {
            Ok(c) => changed |= c,
            Err(e) => warn!(error = %e, node_id = node_id.as_i64(), "set_advertised_routes failed"),
        }
    }
    changed |= apply_auto_approvers(state, node_id).await;
    if !changed {
        return;
    }
    // Peers already get a NodeUpdated delta from the store; the node's own stream
    // ignores its own events, so push a full snapshot when its served routes change.
    let Some(after) = state.store.get_node_info(node_id).await else {
        return;
    };
    let served = |a: &coord_core::NodeAttrs| coord_core::routes::effective_routes(&a.advertised_routes, &a.approved_routes);
    if served(&before.attrs) != served(&after.attrs) {
        state.notify_tenant_changed(after.tenant_id);
    }
}

/// Add any advertised routes the tenant's auto-approvers cover to the node's
/// approved set. Never removes approvals. Returns true if the set changed.
pub(crate) async fn apply_auto_approvers(state: &Arc<CoordinatorState>, node_id: NodeId) -> bool {
    let Some(detail) = state.store.get_node_info(node_id).await else {
        return false;
    };
    let policy = state.auto_approvers.get_tenant(detail.tenant_id);
    let auto = policy.approvable(&detail.attrs.tags, &detail.attrs.advertised_routes);
    if auto.iter().all(|r| detail.attrs.approved_routes.contains(r)) {
        return false;
    }
    let mut approved = detail.attrs.approved_routes.clone();
    approved.extend(auto);
    approved.sort();
    approved.dedup();
    match state.store.set_approved_routes(node_id, approved).await {
        Ok(changed) => {
            if changed {
                info!(node_id = node_id.as_i64(), "routes auto-approved");
            }
            changed
        }
        Err(e) => {
            warn!(error = %e, node_id = node_id.as_i64(), "auto-approve failed");
            false
        }
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
