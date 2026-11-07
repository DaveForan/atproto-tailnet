use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use coord_core::TenantId;
use crate::state::CoordinatorState;

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
            Ok(uuid) => TenantId::new(uuid),
            Err(_) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"error": "invalid tenant_id"})),
                )
                    .into_response();
            }
        },
        None => TenantId::generate(),
    };

    let reusable = body.reusable.unwrap_or(false);
    let key = state.store.create_preauth_key(tenant_id, reusable);

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

pub async fn list_nodes(
    State(state): State<Arc<CoordinatorState>>,
) -> impl IntoResponse {
    let nodes = state.store.list_nodes();
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
    }))
}
