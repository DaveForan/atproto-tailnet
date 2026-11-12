use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use coord_core::{NodeId, TenantId};
use tracing::error;
use crate::state::CoordinatorState;
use coord_core::{is_valid_slug, is_valid_hostname, generate_random_slug};

fn internal_error(e: impl std::fmt::Display) -> impl IntoResponse {
    error!(error = %e, "internal error");
    (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "internal error"})))
}

// ── Tenant management ──

#[derive(Deserialize)]
pub struct CreateTenantRequest {
    pub slug: String,
    pub parent_id: Option<String>,
    pub federation_posture: Option<String>,
}

#[derive(Serialize)]
pub struct TenantResponse {
    pub id: String,
    pub slug: String,
    pub parent_id: Option<String>,
    pub federation_posture: String,
    pub ipv4_prefix: String,
    pub ipv6_prefix: String,
    pub created_at: String,
}

impl From<coord_core::Tenant> for TenantResponse {
    fn from(t: coord_core::Tenant) -> Self {
        Self {
            id: t.id.to_string(),
            slug: t.slug,
            parent_id: t.parent_id.map(|p| p.to_string()),
            federation_posture: t.federation_posture.as_str().to_string(),
            ipv4_prefix: t.ipv4_prefix,
            ipv6_prefix: t.ipv6_prefix,
            created_at: t.created_at.to_rfc3339(),
        }
    }
}

pub async fn create_tenant(
    State(state): State<Arc<CoordinatorState>>,
    Json(body): Json<CreateTenantRequest>,
) -> impl IntoResponse {
    if !is_valid_slug(&body.slug) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "invalid slug: must match ^[a-z0-9][a-z0-9-]{0,62}$"})),
        ).into_response();
    }

    let parent_id = match &body.parent_id {
        Some(id) => match id.parse::<uuid::Uuid>() {
            Ok(uuid) => Some(TenantId::new(uuid)),
            Err(_) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"error": "invalid parent_id"})),
                ).into_response();
            }
        },
        None => None,
    };

    let posture = match &body.federation_posture {
        Some(p) => match p.parse::<coord_core::FederationPosture>() {
            Ok(fp) => Some(fp),
            Err(_) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"error": "invalid federation_posture: must be open, selective, or closed"})),
                ).into_response();
            }
        },
        None => None,
    };

    match state.store.create_tenant(body.slug, parent_id, posture).await {
        Ok(tenant) => (
            StatusCode::CREATED,
            Json(serde_json::json!(TenantResponse::from(tenant))),
        ).into_response(),
        Err(e) => {
            error!(error = %e, "tenant creation failed");
            (
                StatusCode::CONFLICT,
                Json(serde_json::json!({"error": "tenant creation failed (duplicate slug?)"})),
            ).into_response()
        }
    }
}

pub async fn list_tenants(
    State(state): State<Arc<CoordinatorState>>,
) -> impl IntoResponse {
    let tenants = state.store.list_tenants().await;
    let responses: Vec<TenantResponse> = tenants.into_iter().map(TenantResponse::from).collect();
    Json(serde_json::json!({
        "tenants": responses,
        "count": responses.len(),
    }))
}

pub async fn get_tenant(
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

    match state.store.get_tenant(tenant_id).await {
        Some(tenant) => {
            let children = state.store.get_child_tenants(tenant_id).await;
            let child_responses: Vec<TenantResponse> = children.into_iter().map(TenantResponse::from).collect();
            Json(serde_json::json!({
                "tenant": TenantResponse::from(tenant),
                "children": child_responses,
            })).into_response()
        }
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "tenant not found"})),
        ).into_response(),
    }
}

pub async fn delete_tenant(
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

    match state.store.delete_tenant(tenant_id).await {
        Ok(()) => {
            // Clean up any ACL policy for the deleted tenant
            state.acl.remove_policy(tenant_id);
            (
                StatusCode::OK,
                Json(serde_json::json!({"status": "deleted", "tenant_id": id})),
            ).into_response()
        }
        Err(coord_core::CoordError::TenantNotFound(_)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "tenant not found"})),
        ).into_response(),
        Err(coord_core::CoordError::Protocol(ref msg)) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({"error": msg.clone()})),
        ).into_response(),
        Err(e) => internal_error(e).into_response(),
    }
}

// ── Tenant posture management ──

#[derive(Deserialize)]
pub struct UpdatePostureRequest {
    pub posture: String,
}

pub async fn update_tenant_posture(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
    Json(body): Json<UpdatePostureRequest>,
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

    let posture: coord_core::FederationPosture = match body.posture.parse() {
        Ok(p) => p,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "invalid posture: must be open, selective, or closed"})),
            ).into_response();
        }
    };

    match state.store.update_tenant_posture(tenant_id, posture).await {
        Ok(tenant) => Json(serde_json::json!(TenantResponse::from(tenant))).into_response(),
        Err(e) => internal_error(e).into_response(),
    }
}

// ── Preauth key management ──

#[derive(Deserialize)]
pub struct CreateKeyRequest {
    pub tenant_id: Option<String>,
    pub reusable: Option<bool>,
}

#[derive(Serialize)]
pub struct CreateKeyResponse {
    pub key: String,
    pub tenant_id: String,
}

pub async fn create_preauth_key(
    State(state): State<Arc<CoordinatorState>>,
    Json(body): Json<CreateKeyRequest>,
) -> impl IntoResponse {
    let tenant_id = match &body.tenant_id {
        Some(id) => match id.parse::<uuid::Uuid>() {
            Ok(uuid) => {
                let tid = TenantId::new(uuid);
                if state.store.get_tenant(tid).await.is_none() {
                    return (
                        StatusCode::NOT_FOUND,
                        Json(serde_json::json!({"error": "tenant not found — create it first via POST /api/tenants"})),
                    ).into_response();
                }
                tid
            }
            Err(_) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"error": "invalid tenant_id"})),
                )
                    .into_response();
            }
        },
        None => {
            let tenant = match state.store.create_tenant(
                format!("auto-{}", generate_random_slug()),
                None,
                None,
            ).await {
                Ok(t) => t,
                Err(e) => {
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({"error": format!("failed to create auto tenant: {}", e)})),
                    ).into_response();
                }
            };
            tenant.id
        }
    };

    let reusable = body.reusable.unwrap_or(false);
    let key = match state.store.create_preauth_key(tenant_id, reusable).await {
        Ok(k) => k,
        Err(e) => {
            return internal_error(e).into_response();
        }
    };

    (
        StatusCode::CREATED,
        Json(CreateKeyResponse {
            key,
            tenant_id: tenant_id.to_string(),
        }),
    )
        .into_response()
}

#[derive(Serialize)]
pub struct NodeSummaryResponse {
    pub id: i64,
    pub tenant_id: String,
    pub ipv4: String,
    pub stable_id: String,
    pub hostname: String,
    pub online: bool,
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
        }
    }
}

#[derive(Deserialize)]
pub struct SetAclRequest {
    pub tenant_id: String,
    pub policy: coord_acl::AclPolicy,
}

pub async fn set_acl(
    State(state): State<Arc<CoordinatorState>>,
    Json(body): Json<SetAclRequest>,
) -> impl IntoResponse {
    let tenant_id = match body.tenant_id.parse::<uuid::Uuid>() {
        Ok(uuid) => TenantId::new(uuid),
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "invalid tenant_id"})),
            )
                .into_response();
        }
    };

    // Verify tenant exists before storing a policy
    if state.store.get_tenant(tenant_id).await.is_none() {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "tenant not found"})),
        )
            .into_response();
    }

    state.acl.set_policy(tenant_id, body.policy);

    (
        StatusCode::OK,
        Json(serde_json::json!({"status": "ok", "tenant_id": tenant_id.to_string()})),
    )
        .into_response()
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
            "visible": c.federation_posture != coord_core::FederationPosture::Closed,
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
        .flat_map(|p| p.allowed_ips.clone())
        .collect();

    let aggregated_child_routes: Vec<serde_json::Value> = snapshot.visible_child_nodes.iter()
        .map(|(child_id, slug, nodes)| {
            let routes: Vec<String> = nodes.iter()
                .flat_map(|p| p.allowed_ips.clone())
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

// ── ACL read/write by tenant path ──

pub async fn get_acl(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let tenant_id = match id.parse::<uuid::Uuid>() {
        Ok(uuid) => TenantId::new(uuid),
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "invalid tenant_id"}))).into_response(),
    };

    match state.acl.get_policy(tenant_id) {
        Some(policy) => Json(serde_json::json!(policy)).into_response(),
        None => {
            // No policy set = allow-all default
            Json(serde_json::json!({
                "default_deny": false,
                "rules": [{"src": "*", "dst": "*", "ports": [{"range": [0, 65535]}]}]
            })).into_response()
        }
    }
}

pub async fn set_acl_for_tenant(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
    Json(body): Json<coord_acl::AclPolicy>,
) -> impl IntoResponse {
    let tenant_id = match id.parse::<uuid::Uuid>() {
        Ok(uuid) => TenantId::new(uuid),
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "invalid tenant_id"}))).into_response(),
    };
    // Verify tenant exists before storing a policy
    if state.store.get_tenant(tenant_id).await.is_none() {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "tenant not found"}))).into_response();
    }
    state.acl.set_policy(tenant_id, body);
    (StatusCode::OK, Json(serde_json::json!({"status": "ok"}))).into_response()
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
        Some(detail) => Json(serde_json::json!({
            "id": node_id.as_i64(),
            "tenant_id": detail.tenant_id.to_string(),
            "ipv4": detail.ipv4.to_string(),
            "stable_id": detail.stable_id,
            "hostname": detail.info.hostname,
            "online": true,
        })).into_response(),
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
            // Return updated node info
            match state.store.get_node_info(node_id).await {
                Some(detail) => Json(serde_json::json!({
                    "id": node_id.as_i64(),
                    "tenant_id": detail.tenant_id.to_string(),
                    "ipv4": detail.ipv4.to_string(),
                    "stable_id": detail.stable_id,
                    "hostname": detail.info.hostname,
                    "online": true,
                })).into_response(),
                None => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "node not found"}))).into_response(),
            }
        }
        Err(e) => internal_error(e).into_response(),
    }
}

