use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use coord_core::TenantId;
use tracing::error;
use crate::state::CoordinatorState;
use coord_core::is_valid_slug;
use super::{bad_request, internal_error, not_found, parse_tenant_id};

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
    pub suspended: bool,
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
            suspended: t.suspended,
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
        Some(p) => match parse_posture(p) {
            Ok(fp) => Some(fp),
            Err(msg) => {
                return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": msg }))).into_response();
            }
        },
        None => None,
    };

    match state.store.create_tenant(body.slug, parent_id, posture).await {
        Ok(tenant) => (
            StatusCode::CREATED,
            Json(serde_json::json!(TenantResponse::from(tenant))),
        ).into_response(),
        Err(coord_core::CoordError::TenantNotFound(_)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "parent tenant not found"})),
        ).into_response(),
        Err(coord_core::CoordError::Protocol(ref msg)) if msg.contains("already exists") => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({"error": msg.clone()})),
        ).into_response(),
        Err(coord_core::CoordError::Protocol(ref msg)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": msg.clone()})),
        ).into_response(),
        Err(e) => {
            error!(error = %e, "tenant creation failed");
            internal_error(e).into_response()
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
            // The stored configuration went with the tenant row; drop the caches here and on other replicas
            state.forget_tenant_config(tenant_id);
            state.notify_tenant_changed(tenant_id);
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

/// A posture the admin API accepts: `open` or `closed`.
fn parse_posture(s: &str) -> Result<coord_core::FederationPosture, &'static str> {
    match s.parse() {
        Ok(coord_core::FederationPosture::Selective) => Err("selective posture is not implemented"),
        Ok(p) => Ok(p),
        Err(_) => Err("invalid federation posture: must be open or closed"),
    }
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

    let posture = match parse_posture(&body.posture) {
        Ok(p) => p,
        Err(msg) => {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": msg }))).into_response();
        }
    };

    match state.store.update_tenant_posture(tenant_id, posture).await {
        Ok(tenant) => {
            state.notify_tenant_changed(tenant_id);
            if let Some(parent) = tenant.parent_id {
                state.notify_tenant_changed(parent);
            }
            state.refresh_relay_scopes(tenant_id).await;
            Json(serde_json::json!(TenantResponse::from(tenant))).into_response()
        }
        Err(coord_core::CoordError::TenantNotFound(_)) => not_found("tenant not found"),
        Err(e) => internal_error(e).into_response(),
    }
}

#[derive(Deserialize)]
pub struct SetSuspendedRequest {
    pub suspended: bool,
}

/// PUT /api/tenants/{id}/suspended — instance-operator suspension. While
/// suspended the tenant's nodes cannot register or poll the map, and live map
/// streams end (via the config_changed broadcast, which re-checks suspension).
pub async fn set_tenant_suspended(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
    Json(body): Json<SetSuspendedRequest>,
) -> impl IntoResponse {
    let Some(tenant_id) = parse_tenant_id(&id) else {
        return bad_request("invalid tenant_id");
    };
    match state.store.set_tenant_suspended(tenant_id, body.suspended).await {
        Ok(tenant) => {
            tracing::info!(tenant = %tenant_id, suspended = body.suspended, "tenant suspension changed");
            state.notify_tenant_changed(tenant_id);
            if let Some(parent) = tenant.parent_id {
                state.notify_tenant_changed(parent);
            }
            state.refresh_relay_scopes(tenant_id).await;
            Json(serde_json::json!(TenantResponse::from(tenant))).into_response()
        }
        Err(coord_core::CoordError::TenantNotFound(_)) => not_found("tenant not found"),
        Err(e) => internal_error(e).into_response(),
    }
}

/// PUT /api/tenants/{id}/parent — body `{"parent_id": "<uuid>" | null}`; null detaches the tenant.
/// Live streams of the tenant and of the old and new parent resend their peers.
pub async fn set_tenant_parent(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let Some(tenant_id) = parse_tenant_id(&id) else {
        return bad_request("invalid tenant_id");
    };
    // The field is required, so a typo cannot detach a tenant by accident.
    let parent_id = match body.get("parent_id") {
        Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(p)) => match parse_tenant_id(p) {
            Some(p) => Some(p),
            None => return bad_request("invalid parent_id"),
        },
        _ => return bad_request("parent_id is required: a tenant id or null"),
    };
    match state.store.set_tenant_parent(tenant_id, parent_id).await {
        Ok((tenant, old_parent)) => {
            tracing::info!(tenant = %tenant_id, parent = ?parent_id, old_parent = ?old_parent, "tenant parent changed");
            let mut changed = vec![tenant_id];
            changed.extend(old_parent);
            changed.extend(parent_id);
            changed.dedup();
            for t in changed {
                state.notify_tenant_changed(t);
            }
            state.refresh_relay_scopes(tenant_id).await;
            Json(serde_json::json!(TenantResponse::from(tenant))).into_response()
        }
        Err(coord_core::CoordError::TenantNotFound(missing)) if missing == tenant_id => not_found("tenant not found"),
        Err(coord_core::CoordError::TenantNotFound(_)) => not_found("parent tenant not found"),
        Err(coord_core::CoordError::Protocol(msg)) => bad_request(&msg),
        Err(e) => internal_error(e).into_response(),
    }
}
