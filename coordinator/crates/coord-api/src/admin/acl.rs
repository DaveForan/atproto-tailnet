use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use std::sync::Arc;

use coord_core::TenantId;
use crate::state::CoordinatorState;

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

    if state.store.get_tenant(tenant_id).await.is_none() {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "tenant not found"})),
        )
            .into_response();
    }

    if let Err(r) = state.save_config(tenant_id, crate::state::CONFIG_ACL, &body.policy).await {
        return r;
    }
    state.caches.acl.set_policy(tenant_id, body.policy);
    state.notify_tenant_changed(tenant_id);

    (
        StatusCode::OK,
        Json(serde_json::json!({"status": "ok", "tenant_id": tenant_id.to_string()})),
    )
        .into_response()
}


pub async fn get_acl(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let tenant_id = match id.parse::<uuid::Uuid>() {
        Ok(uuid) => TenantId::new(uuid),
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "invalid tenant_id"}))).into_response(),
    };

    match state.caches.acl.get_policy(tenant_id) {
        Some(policy) => Json(serde_json::json!(policy)).into_response(),
        None => {
            // No stored policy means the allow-all default.
            Json(serde_json::json!({
                "default_deny": false,
                "rules": [{"src": "*", "dst": "*", "ports": ["All"]}]
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
    if state.store.get_tenant(tenant_id).await.is_none() {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "tenant not found"}))).into_response();
    }
    if let Err(r) = state.save_config(tenant_id, crate::state::CONFIG_ACL, &body).await {
        return r;
    }
    state.caches.acl.set_policy(tenant_id, body);
    state.notify_tenant_changed(tenant_id);
    (StatusCode::OK, Json(serde_json::json!({"status": "ok"}))).into_response()
}
