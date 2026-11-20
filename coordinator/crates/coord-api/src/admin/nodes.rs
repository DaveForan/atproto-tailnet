use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use coord_core::{NodeId, TenantId};
use crate::state::CoordinatorState;
use coord_core::is_valid_hostname;
use super::{bad_request, existing_tenant, internal_error, required_owner, OwnerQuery};

/// DELETE /api/tenants/{id}/nodes?owner=X — deleting a node ends its map stream.
pub async fn delete_tenant_nodes_by_owner(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
    Query(query): Query<OwnerQuery>,
) -> impl IntoResponse {
    let tenant_id = match existing_tenant(&state, &id).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    let owner = match required_owner(query) {
        Ok(o) => o,
        Err(msg) => return bad_request(msg),
    };
    match state.store.delete_nodes_by_owner(tenant_id, &owner).await {
        Ok(ids) => {
            tracing::info!(tenant = %tenant_id, deleted = ids.len(), "deleted nodes by owner");
            Json(serde_json::json!({"deleted": ids.len()})).into_response()
        }
        Err(e) => internal_error(e).into_response(),
    }
}

#[derive(Serialize)]
pub struct NodeSummaryResponse {
    pub id: i64,
    pub tenant_id: String,
    pub ipv4: String,
    pub stable_id: String,
    pub hostname: String,
    pub online: bool,
    pub owner: Option<String>,
    pub tags: Vec<String>,
    pub ephemeral: bool,
    pub advertised_routes: Vec<String>,
    pub approved_routes: Vec<String>,
}

impl From<coord_core::NodeSummary> for NodeSummaryResponse {
    fn from(n: coord_core::NodeSummary) -> Self {
        Self {
            id: n.id.as_i64(),
            tenant_id: n.tenant_id.to_string(),
            ipv4: n.ipv4.to_string(),
            stable_id: n.stable_id,
            hostname: n.hostname,
            online: n.online,
            owner: n.attrs.owner,
            tags: n.attrs.tags,
            ephemeral: n.attrs.ephemeral,
            advertised_routes: n.attrs.advertised_routes,
            approved_routes: n.attrs.approved_routes,
        }
    }
}

pub(super) fn node_detail_json(node_id: NodeId, detail: coord_core::NodeDetail) -> NodeSummaryResponse {
    NodeSummaryResponse::from(coord_core::NodeSummary {
        id: node_id,
        tenant_id: detail.tenant_id,
        ipv4: detail.ipv4,
        stable_id: detail.stable_id,
        online: detail.online,
        hostname: detail.info.hostname,
        attrs: detail.attrs,
    })
}

#[derive(Deserialize)]
pub struct ListNodesQuery {
    pub tenant_id: Option<String>,
}

pub async fn list_nodes(
    State(state): State<Arc<CoordinatorState>>,
    Query(query): Query<ListNodesQuery>,
) -> impl IntoResponse {
    let nodes = match &query.tenant_id {
        Some(id) => match id.parse::<uuid::Uuid>() {
            Ok(uuid) => state.store.list_nodes_for_tenant(TenantId::new(uuid)).await,
            Err(_) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"error": "invalid tenant_id"})),
                ).into_response();
            }
        },
        None => state.store.list_nodes().await,
    };

    let summaries: Vec<NodeSummaryResponse> = nodes
        .into_iter()
        .map(NodeSummaryResponse::from)
        .collect();

    Json(serde_json::json!({
        "nodes": summaries,
        "count": summaries.len(),
    })).into_response()
}

// ── Tenant-scoped node listing ──

pub async fn list_tenant_nodes_handler(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let tenant_id = match id.parse::<uuid::Uuid>() {
        Ok(uuid) => TenantId::new(uuid),
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "invalid tenant_id"}))).into_response(),
    };

    let nodes = state.store.list_nodes_for_tenant(tenant_id).await;
    let summaries: Vec<NodeSummaryResponse> = nodes.into_iter()
        .map(NodeSummaryResponse::from)
        .collect();

    Json(serde_json::json!({"nodes": summaries, "count": summaries.len()})).into_response()
}

// ── Node operations: get, delete, rename ──

#[derive(Deserialize)]
pub struct RenameNodeRequest {
    pub name: String,
}

#[derive(Deserialize)]
pub struct TenantGuardQuery {
    pub tenant_id: Option<String>,
}

/// Returns node info including tenant_id.
/// NOTE: This is an admin endpoint — it intentionally returns data across all
/// tenants. Callers that need tenant-scoped access should use the tenant-scoped
/// node listing endpoint instead.
pub async fn get_node_handler(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let node_id = match id.parse::<i64>() {
        Ok(id) => NodeId::new(id),
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "invalid node_id"}))).into_response(),
    };
    match state.store.get_node_info(node_id).await {
        Some(detail) => Json(node_detail_json(node_id, detail)).into_response(),
        None => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "node not found"}))).into_response(),
    }
}

pub async fn delete_node_handler(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
    Query(query): Query<TenantGuardQuery>,
) -> impl IntoResponse {
    let node_id = match id.parse::<i64>() {
        Ok(id) => NodeId::new(id),
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "invalid node_id"}))).into_response(),
    };

    // If caller specifies tenant_id, verify the node belongs to that tenant before deleting.
    if let Some(ref tid_str) = query.tenant_id {
        let expected_tenant = match tid_str.parse::<uuid::Uuid>() {
            Ok(uuid) => TenantId::new(uuid),
            Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "invalid tenant_id"}))).into_response(),
        };
        let actual_tenant = state.store.get_node_tenant(node_id).await;
        if actual_tenant != Some(expected_tenant) {
            return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "node does not belong to specified tenant"}))).into_response();
        }
    }

    match state.store.delete_node(node_id).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({"status": "deleted"}))).into_response(),
        Err(coord_core::CoordError::Protocol(ref msg)) if msg.contains("not found") => {
            (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "node not found"}))).into_response()
        }
        Err(e) => internal_error(e).into_response(),
    }
}

pub async fn rename_node_handler(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
    Query(query): Query<TenantGuardQuery>,
    Json(body): Json<RenameNodeRequest>,
) -> impl IntoResponse {
    let node_id = match id.parse::<i64>() {
        Ok(id) => NodeId::new(id),
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "invalid node_id"}))).into_response(),
    };

    if !is_valid_hostname(&body.name) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "invalid hostname: must match ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$"})),
        ).into_response();
    }

    // If caller specifies tenant_id, verify the node belongs to that tenant before renaming.
    if let Some(ref tid_str) = query.tenant_id {
        let expected_tenant = match tid_str.parse::<uuid::Uuid>() {
            Ok(uuid) => TenantId::new(uuid),
            Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "invalid tenant_id"}))).into_response(),
        };
        let actual_tenant = state.store.get_node_tenant(node_id).await;
        if actual_tenant != Some(expected_tenant) {
            return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "node does not belong to specified tenant"}))).into_response();
        }
    }

    match state.store.rename_node(node_id, body.name).await {
        Ok(()) => {
            match state.store.get_node_info(node_id).await {
                Some(detail) => Json(node_detail_json(node_id, detail)).into_response(),
                None => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "node not found"}))).into_response(),
            }
        }
        Err(coord_core::CoordError::Protocol(ref msg)) if msg.contains("not found") => {
            (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "node not found"}))).into_response()
        }
        Err(e) => internal_error(e).into_response(),
    }
}
