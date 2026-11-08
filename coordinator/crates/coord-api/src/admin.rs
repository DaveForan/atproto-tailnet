use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use coord_core::{NodeId, TenantId};
use crate::state::CoordinatorState;

// ── Tenant management ──

#[derive(Deserialize)]
pub struct CreateTenantRequest {
    pub slug: String,
    pub parent_id: Option<String>,
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
            federation_posture: format!("{:?}", t.federation_posture).to_lowercase(),
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

    match state.store.create_tenant(body.slug, parent_id).await {
        Ok(tenant) => (
            StatusCode::CREATED,
            Json(serde_json::json!(TenantResponse::from(tenant))),
        ).into_response(),
        Err(e) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({"error": e.to_string()})),
        ).into_response(),
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
        Ok(()) => (
            StatusCode::OK,
            Json(serde_json::json!({"status": "deleted", "tenant_id": id})),
        ).into_response(),
        Err(e) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": e.to_string()})),
        ).into_response(),
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
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e.to_string()})),
            ).into_response();
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
pub struct NodeSummary {
    pub id: i64,
    pub tenant_id: String,
    pub ipv4: String,
    pub stable_id: String,
    pub hostname: String,
    pub online: bool,
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

    let summaries: Vec<NodeSummary> = nodes
        .into_iter()
        .map(|(id, tid, ipv4, stable_id, online, hostname)| NodeSummary {
            id: id.as_i64(),
            tenant_id: tid.to_string(),
            ipv4: ipv4.to_string(),
            stable_id,
            hostname,
            online,
        })
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

    if state.store.get_tenant(tenant_id).await.is_none() {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "tenant not found"})),
        ).into_response();
    }

    let children = state.store.get_child_tenants(tenant_id).await;
    let child_summaries: Vec<serde_json::Value> = children.iter().map(|c| {
        let mut obj = serde_json::json!({
            "id": c.id.to_string(),
            "slug": &c.slug,
            "federation_posture": format!("{:?}", c.federation_posture).to_lowercase(),
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

    let own_nodes = state.store.list_tenant_nodes(tenant_id).await;
    let own_routes: Vec<String> = own_nodes.iter()
        .flat_map(|p| p.allowed_ips.clone())
        .collect();

    let mut aggregated_child_routes: Vec<serde_json::Value> = Vec::new();
    for child in &children {
        if child.federation_posture == coord_core::FederationPosture::Closed {
            continue;
        }
        let nodes = state.store.list_tenant_nodes(child.id).await;
        let routes: Vec<String> = nodes.iter()
            .flat_map(|p| p.allowed_ips.clone())
            .collect();
        aggregated_child_routes.push(serde_json::json!({
            "tenant_id": child.id.to_string(),
            "slug": &child.slug,
            "routes": routes,
            "node_count": nodes.len(),
        }));
    }

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
    let summaries: Vec<NodeSummary> = nodes.into_iter()
        .map(|(id, tid, ipv4, stable_id, online, hostname)| NodeSummary {
            id: id.as_i64(), tenant_id: tid.to_string(), ipv4: ipv4.to_string(),
            stable_id, hostname, online,
        })
        .collect();
    let count = summaries.len();

    Json(serde_json::json!({"nodes": summaries, "count": count})).into_response()
}

// ── Node operations: get, delete, rename ──

#[derive(Deserialize)]
pub struct RenameNodeRequest {
    pub name: String,
}

pub async fn get_node_handler(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let node_id = match id.parse::<i64>() {
        Ok(id) => NodeId::new(id),
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "invalid node_id"}))).into_response(),
    };
    match state.store.get_node_info(node_id).await {
        Some((tid, ipv4, stable_id, info)) => Json(serde_json::json!({
            "id": node_id.as_i64(),
            "tenant_id": tid.to_string(),
            "ipv4": ipv4.to_string(),
            "stable_id": stable_id,
            "hostname": info.hostname,
            "online": true,
        })).into_response(),
        None => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "node not found"}))).into_response(),
    }
}

pub async fn delete_node_handler(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let node_id = match id.parse::<i64>() {
        Ok(id) => NodeId::new(id),
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "invalid node_id"}))).into_response(),
    };
    match state.store.delete_node(node_id).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({"status": "deleted"}))).into_response(),
        Err(e) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

pub async fn rename_node_handler(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
    Json(body): Json<RenameNodeRequest>,
) -> impl IntoResponse {
    let node_id = match id.parse::<i64>() {
        Ok(id) => NodeId::new(id),
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "invalid node_id"}))).into_response(),
    };
    match state.store.rename_node(node_id, body.name).await {
        Ok(()) => {
            // Return updated node info
            match state.store.get_node_info(node_id).await {
                Some((tid, ipv4, stable_id, info)) => Json(serde_json::json!({
                    "id": node_id.as_i64(),
                    "tenant_id": tid.to_string(),
                    "ipv4": ipv4.to_string(),
                    "stable_id": stable_id,
                    "hostname": info.hostname,
                    "online": true,
                })).into_response(),
                None => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "node not found"}))).into_response(),
            }
        }
        Err(e) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

fn generate_random_slug() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 4];
    rand::rng().fill_bytes(&mut buf);
    hex::encode(buf)
}
