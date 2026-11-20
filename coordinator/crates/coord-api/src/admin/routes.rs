use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use std::sync::Arc;

use coord_core::{NodeId, TenantId};
use crate::state::CoordinatorState;
use super::{bad_request, existing_tenant, internal_error, not_found};
use super::nodes::node_detail_json;

#[derive(Deserialize)]
pub struct ApproveRoutesRequest {
    pub approved: Vec<String>,
}

/// POST /api/tenants/{id}/nodes/{node_id}/routes — the only manual approval path.
pub async fn approve_node_routes(
    State(state): State<Arc<CoordinatorState>>,
    Path((id, node_id)): Path<(String, String)>,
    Json(body): Json<ApproveRoutesRequest>,
) -> impl IntoResponse {
    let tenant_id = match existing_tenant(&state, &id).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    let Ok(node_id) = node_id.parse::<i64>().map(NodeId::new) else {
        return bad_request("invalid node_id");
    };
    let approved = match coord_core::routes::normalize_routes_strict(&body.approved) {
        Ok(r) => r,
        Err(bad) => return bad_request(format!("invalid CIDR: {bad}")),
    };
    let Some(detail) = state.store.get_node_info(node_id).await.filter(|d| d.tenant_id == tenant_id) else {
        return not_found("node not found");
    };
    if let Some(bad) = approved.iter().find(|r| !detail.attrs.advertised_routes.contains(r)) {
        return bad_request(format!("route {bad} is not advertised by this node"));
    }
    match state.store.set_approved_routes(node_id, approved).await {
        Ok(changed) => {
            if changed {
                state.notify_tenant_changed(tenant_id);
            }
        }
        Err(coord_core::CoordError::Protocol(ref msg)) if msg.contains("not found") => {
            return not_found("node not found");
        }
        Err(e) => return internal_error(e).into_response(),
    }
    match state.store.get_node_info(node_id).await {
        Some(detail) => Json(node_detail_json(node_id, detail)).into_response(),
        None => not_found("node not found"),
    }
}

pub async fn get_tenant_routes(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let tenant_id = match id.parse::<uuid::Uuid>() {
        Ok(uuid) => TenantId::new(uuid),
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "invalid tenant_id"})),
            ).into_response();
        }
    };

    // Use atomic snapshot to prevent posture/nodes interleaving
    let snapshot = match state.store.get_tenant_route_snapshot(tenant_id).await {
        Ok(s) => s,
        Err(_) => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "tenant not found"})),
            ).into_response();
        }
    };

    let child_summaries: Vec<serde_json::Value> = snapshot.children.iter().map(|c| {
        let mut obj = serde_json::json!({
            "id": c.id.to_string(),
            "slug": &c.slug,
            "federation_posture": c.federation_posture.as_str(),
            "visible": c.visible_to_parent(),
        });
        // FIX R15: Document that Selective == Open for now
        if c.federation_posture == coord_core::FederationPosture::Selective {
            obj.as_object_mut().unwrap().insert(
                "posture_note".into(),
                serde_json::Value::String("selective is currently treated as open".into()),
            );
        }
        obj
    }).collect();

    let own_routes: Vec<String> = snapshot.own_nodes.iter()
        .flat_map(|p| p.addresses.clone())
        .collect();

    let aggregated_child_routes: Vec<serde_json::Value> = snapshot.visible_child_nodes.iter()
        .map(|(child_id, slug, nodes)| {
            let routes: Vec<String> = nodes.iter()
                .flat_map(|p| p.addresses.clone())
                .collect();
            serde_json::json!({
                "tenant_id": child_id.to_string(),
                "slug": slug,
                "routes": routes,
                "node_count": nodes.len(),
            })
        })
        .collect();

    Json(serde_json::json!({
        "tenant_id": id,
        "own_routes": own_routes,
        "children": child_summaries,
        "aggregated_child_routes": aggregated_child_routes,
    })).into_response()
}

const MAX_AUTO_APPROVER_ROUTES: usize = 256;

/// GET /api/tenants/{id}/auto-approvers
pub async fn get_auto_approvers(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let tenant_id = match existing_tenant(&state, &id).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    Json(state.auto_approvers.get_tenant(tenant_id)).into_response()
}

/// PUT /api/tenants/{id}/auto-approvers — replaces the tenant's policy and
/// applies it to already-registered nodes.
pub async fn set_auto_approvers(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
    Json(body): Json<coord_netmap::AutoApprovers>,
) -> impl IntoResponse {
    let tenant_id = match existing_tenant(&state, &id).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    if body.routes.len() > MAX_AUTO_APPROVER_ROUTES {
        return bad_request(format!("at most {MAX_AUTO_APPROVER_ROUTES} auto-approver routes allowed"));
    }
    let mut routes = std::collections::BTreeMap::new();
    for (cidr, tags) in body.routes {
        let Some(norm) = coord_core::routes::normalize_cidr(&cidr) else {
            return bad_request(format!("invalid CIDR: {cidr}"));
        };
        let tags = match validate_auto_approver_tags(tags) {
            Ok(t) => t,
            Err(e) => return bad_request(e),
        };
        routes.entry(norm).or_insert_with(Vec::new).extend(tags);
    }
    for tags in routes.values_mut() {
        tags.sort();
        tags.dedup();
    }
    let exit_node = match validate_auto_approver_tags(body.exit_node) {
        Ok(t) => t,
        Err(e) => return bad_request(e),
    };
    let policy = coord_netmap::AutoApprovers { routes, exit_node };
    if let Err(r) = state.save_config(tenant_id, crate::state::CONFIG_AUTO_APPROVERS, &policy).await {
        return r;
    }
    state.auto_approvers.set_tenant(tenant_id, policy.clone());

    for node in state.store.list_nodes_for_tenant(tenant_id).await {
        crate::control::apply_auto_approvers(&state, node.id).await;
    }
    // Always notify: other replicas cache the policy and must reload it even
    // when no node's approved routes changed here.
    state.notify_tenant_changed(tenant_id);
    Json(policy).into_response()
}

fn validate_auto_approver_tags(tags: Vec<String>) -> Result<Vec<String>, String> {
    if tags.len() > 64 {
        return Err("at most 64 tags per auto-approver entry".into());
    }
    if let Some(bad) = tags.iter().find(|t| !coord_core::routes::is_valid_tag(t)) {
        return Err(format!("invalid tag {bad:?}: must match ^tag:[a-z0-9-]{{1,63}}$"));
    }
    let mut tags = tags;
    tags.sort();
    tags.dedup();
    Ok(tags)
}
