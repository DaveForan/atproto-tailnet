mod state;
mod key_handler;
mod noise_handler;
mod control;
mod admin;

pub use state::CoordinatorState;

use axum::{
    Router,
    extract::State,
    http::{Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use std::sync::Arc;

/// Constant-time byte comparison to prevent timing side-channels on API key checks.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

async fn require_admin_auth(
    State(state): State<Arc<CoordinatorState>>,
    req: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let expected = match &state.admin_api_key {
        Some(key) => key,
        None => return next.run(req).await, // dev mode: no key configured
    };

    let auth_header = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok());

    let token = auth_header.and_then(|h| h.strip_prefix("Bearer "));

    match token {
        Some(t) if constant_time_eq(t.as_bytes(), expected.as_bytes()) => next.run(req).await,
        _ => (
            StatusCode::UNAUTHORIZED,
            axum::Json(serde_json::json!({"error": "unauthorized: invalid or missing admin API key"})),
        ).into_response(),
    }
}

pub fn router(state: Arc<CoordinatorState>) -> Router {
    // Admin API routes that require auth
    let admin_routes = Router::new()
        .route("/tenants", post(admin::create_tenant).get(admin::list_tenants))
        .route("/tenants/{id}", get(admin::get_tenant).delete(admin::delete_tenant))
        .route("/tenants/{id}/routes", get(admin::get_tenant_routes))
        .route("/tenants/{id}/acl", get(admin::get_acl).post(admin::set_acl_for_tenant))
        .route("/tenants/{id}/posture", put(admin::update_tenant_posture))
        .route("/tenants/{id}/nodes", get(admin::list_tenant_nodes_handler))
        .route("/preauth-keys", post(admin::create_preauth_key))
        .route("/nodes", get(admin::list_nodes))
        .route("/nodes/{id}", get(admin::get_node_handler).delete(admin::delete_node_handler))
        .route("/nodes/{id}/name", post(admin::rename_node_handler))
        .route("/acl", post(admin::set_acl))
        .layer(middleware::from_fn_with_state(state.clone(), require_admin_auth));

    Router::new()
        .route("/health", get(health))
        .route("/key", get(key_handler::key_handler))
        .route("/ts2021", post(noise_handler::ts2021_handler))
        .nest("/api", admin_routes)
        .with_state(state)
}

async fn health() -> &'static str {
    "ok"
}

#[doc(hidden)]
pub async fn __test_handle_register(
    state: &Arc<CoordinatorState>,
    machine_key: &[u8; 32],
    body: &str,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let (json, _generation) = control::handle_register(state, machine_key, body).await?;
    Ok(json)
}

#[doc(hidden)]
pub async fn __test_handle_map(
    state: &Arc<CoordinatorState>,
    machine_key: &[u8; 32],
    body: &str,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    control::handle_map(state, machine_key, body).await
}

#[doc(hidden)]
pub async fn __test_build_delta(
    state: &Arc<CoordinatorState>,
    machine_key: &[u8; 32],
    event: &coord_store::PeerEvent,
) -> Option<String> {
    control::build_delta_response(state, machine_key, event).await
}
