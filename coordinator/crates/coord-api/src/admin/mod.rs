//! Admin REST handlers, grouped by resource. Handlers are re-exported here so
//! the router in `lib.rs` keeps addressing them as `admin::handler_name`.

use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;

use coord_core::TenantId;
use tracing::error;
use crate::state::CoordinatorState;

mod tenants;
mod keys;
mod nodes;
mod routes;
mod identity;
mod access;
mod locks;
mod device_auth;
mod dns;
mod acl;
mod derp;

pub use tenants::*;
pub use keys::*;
pub use nodes::*;
pub use routes::*;
pub use identity::*;
pub use access::*;
pub use locks::*;
pub use device_auth::*;
pub use dns::*;
pub use acl::*;
pub use derp::*;

fn internal_error(e: impl std::fmt::Display) -> impl IntoResponse {
    error!(error = %e, "internal error");
    (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "internal error"})))
}

fn validate_owner(owner: &str) -> Result<(), String> {
    if owner.is_empty() || owner.chars().count() > coord_core::routes::MAX_OWNER_LEN {
        return Err(format!("owner must be 1-{} characters", coord_core::routes::MAX_OWNER_LEN));
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct OwnerQuery {
    pub owner: Option<String>,
}

async fn existing_tenant(state: &CoordinatorState, id: &str) -> Result<TenantId, axum::response::Response> {
    let Some(tenant_id) = parse_tenant_id(id) else {
        return Err(bad_request("invalid tenant_id"));
    };
    if state.store.get_tenant(tenant_id).await.is_none() {
        return Err(not_found("tenant not found"));
    }
    Ok(tenant_id)
}

fn not_found(msg: &str) -> axum::response::Response {
    (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": msg}))).into_response()
}

/// The validated `owner` query parameter, or the message of a 400.
fn required_owner(query: OwnerQuery) -> Result<String, String> {
    let Some(owner) = query.owner else {
        return Err("owner query parameter is required".into());
    };
    validate_owner(&owner)?;
    Ok(owner)
}

fn parse_tenant_id(id: &str) -> Option<TenantId> {
    id.parse::<uuid::Uuid>().ok().map(TenantId::new)
}

fn bad_request(msg: impl Into<String>) -> axum::response::Response {
    (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": msg.into()}))).into_response()
}
