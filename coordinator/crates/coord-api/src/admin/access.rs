use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use std::sync::Arc;

use crate::state::CoordinatorState;
use super::{bad_request, existing_tenant};

/// GET /api/tenants/{id}/access
pub async fn get_tenant_access(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let tenant_id = match existing_tenant(&state, &id).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    Json(state.store.get_tenant_access(tenant_id).await).into_response()
}

/// PUT /api/tenants/{id}/access — replaces the tenant's device access mode
/// and rules (ADR-0036). Connected devices get their new view at once.
pub async fn set_tenant_access(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
    Json(body): Json<coord_core::TenantAccess>,
) -> impl IntoResponse {
    let tenant_id = match existing_tenant(&state, &id).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    if let Err(e) = body.validate() {
        return bad_request(e.to_string());
    }
    let changed = state.store.get_tenant_access(tenant_id).await != body;
    if let Err(e) = state.store.set_tenant_access(tenant_id, body.clone()).await {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response();
    }
    if changed {
        state.notify_tenant_changed(tenant_id);
    }
    Json(body).into_response()
}
