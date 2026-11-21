use axum::extract::{Path, State};
use axum::response::IntoResponse;
use axum::Json;
use std::sync::Arc;

use crate::state::CoordinatorState;
use super::{bad_request, existing_tenant};

/// GET /api/tenants/{id}/identity
pub async fn get_tenant_identity(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let tenant_id = match existing_tenant(&state, &id).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    Json(state.caches.identity.get_tenant(tenant_id)).into_response()
}

/// PUT /api/tenants/{id}/identity — replaces the tenant's tailnet name and
/// owner -> user names shown in Tailscale clients. Live map streams get a
/// fresh snapshot only when something actually changed (the TS service
/// re-pushes this on every monitor sweep).
pub async fn set_tenant_identity(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
    Json(body): Json<coord_netmap::TenantIdentity>,
) -> impl IntoResponse {
    let tenant_id = match existing_tenant(&state, &id).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    let identity = match body.sanitized() {
        Ok(i) => i,
        Err(e) => return bad_request(e.to_string()),
    };
    let changed = state.caches.identity.get_tenant(tenant_id) != identity;
    if let Err(r) = state.save_config(tenant_id, crate::state::CONFIG_IDENTITY, &identity).await {
        return r;
    }
    state.caches.identity.set_tenant(tenant_id, identity.clone());
    if changed {
        state.notify_tenant_changed(tenant_id);
    }
    Json(identity).into_response()
}
