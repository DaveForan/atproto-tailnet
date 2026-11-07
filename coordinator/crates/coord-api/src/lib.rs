mod state;
mod key_handler;
mod noise_handler;
mod control;
mod admin;

pub use state::CoordinatorState;

use axum::{Router, routing::{get, post}};
use std::sync::Arc;

pub fn router(state: Arc<CoordinatorState>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/key", get(key_handler::key_handler))
        .route("/ts2021", post(noise_handler::ts2021_handler))
        .route("/api/preauth-keys", post(admin::create_preauth_key))
        .route("/api/nodes", get(admin::list_nodes))
        .route("/api/acl", post(admin::set_acl))
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
    control::handle_register(state, machine_key, body).await
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
pub fn __test_build_delta(
    state: &Arc<CoordinatorState>,
    machine_key: &[u8; 32],
    event: &coord_store::PeerEvent,
) -> Option<String> {
    control::build_delta_response(state, machine_key, event)
}
