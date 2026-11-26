use axum::extract::{Path, State};
use axum::response::IntoResponse;
use axum::Json;
use std::sync::Arc;

use crate::state::CoordinatorState;
use super::{bad_request, existing_tenant, not_found};
use coord_core::clock;

#[derive(serde::Deserialize)]
pub struct DeviceAuthApproval {
    pub tenant_id: String,
    pub owner: String,
    /// The hold of the new device. Without it, the device waits for its owner.
    pub hold: Option<coord_core::Hold>,
}

/// GET /api/device-auth/{id} — what the approval page shows about a pending sign-in.
pub async fn get_device_auth(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.device_auth.get(&state.store, &id).await {
        Some(p) => Json(serde_json::json!({
            "id": id,
            "hostname": p.hostname,
            "os": p.os,
            "fingerprint": crate::device_auth::fingerprint(&p.machine_key),
            "pending": p.decision.is_none(),
            // Where and when the sign-in was started (ADR-0032 approval page)
            "requester_ip": p.requester_ip,
            "requested_at": clock::to_rfc3339_secs(p.requested_at),
            // Set when the machine is already registered. A machine cannot move between tailnets.
            "registered_tenant_id": match state.store.get_node_by_machine_key(&p.machine_key).await {
                Some(n) => state.store.get_node_tenant(n).await.map(|t| t.to_string()),
                None => None,
            },
        }))
        .into_response(),
        None => not_found("device sign-in not found or expired"),
    }
}

/// POST /api/device-auth/{id}/approve — bind the waiting device to a tenant and owner.
pub async fn approve_device_auth(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
    Json(body): Json<DeviceAuthApproval>,
) -> impl IntoResponse {
    let tenant_id = match existing_tenant(&state, &body.tenant_id).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    if body.owner.is_empty() || body.owner.len() > 128 {
        return bad_request("owner must be 1-128 characters".to_string());
    }
    if state.store.is_tenant_suspended(tenant_id).await {
        return bad_request("tenant is suspended".to_string());
    }
    let decision = coord_core::SignInDecision::Approved { tenant_id, owner: body.owner, hold: body.hold.unwrap_or(coord_core::Hold::Owner) };
    if !state.device_auth.decide(&state.store, &id, decision).await {
        return not_found("device sign-in not found, expired or already answered");
    }
    Json(serde_json::json!({ "status": "approved" })).into_response()
}

/// POST /api/device-auth/{id}/deny
pub async fn deny_device_auth(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !state.device_auth.decide(&state.store, &id, coord_core::SignInDecision::Denied).await {
        return not_found("device sign-in not found, expired or already answered");
    }
    Json(serde_json::json!({ "status": "denied" })).into_response()
}
