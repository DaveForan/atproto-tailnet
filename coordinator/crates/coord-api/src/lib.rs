mod state;
mod key_handler;
pub mod derp_handler;
pub mod device_auth;
mod noise_handler;
mod control;
mod admin;
mod federation;

pub use state::{CoordinatorState, Role};

use axum::{
    Router,
    extract::{DefaultBodyLimit, State},
    http::{Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
};
use std::sync::Arc;

/// Constant-time byte comparison to prevent timing side-channels on API key checks.
/// Compares all bytes of the shorter slice against the longer, preventing length leakage.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    let mut diff = (a.len() ^ b.len()) as u8;
    for i in 0..a.len().max(b.len()) {
        let x = if i < a.len() { a[i] } else { 0 };
        let y = if i < b.len() { b[i] } else { 0 };
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
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                axum::Json(serde_json::json!({"error": "admin API key not configured"})),
            ).into_response();
        }
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
        .route("/tenants/{id}/suspended", put(admin::set_tenant_suspended))
        .route(
            "/tenants/{id}/nodes",
            get(admin::list_tenant_nodes_handler).delete(admin::delete_tenant_nodes_by_owner),
        )
        .route("/tenants/{id}/nodes/{node_id}/routes", post(admin::approve_node_routes))
        .route(
            "/tenants/{id}/preauth-keys",
            get(admin::list_preauth_keys).delete(admin::revoke_preauth_keys_by_owner),
        )
        .route("/tenants/{id}/preauth-keys/{key_id}", delete(admin::revoke_preauth_key))
        .route(
            "/tenants/{id}/auto-approvers",
            get(admin::get_auto_approvers).put(admin::set_auto_approvers),
        )
        .route("/tenants/{id}/derp", get(admin::get_tenant_derp).put(admin::set_tenant_derp))
        .route(
            "/tenants/{id}/owner-locks/{owner}",
            get(admin::get_owner_lock).put(admin::set_owner_lock).delete(admin::delete_owner_lock),
        )
        .route("/tenants/{id}/owner-locks/{owner}/allow-one", post(admin::allow_one_machine))
        .route("/device-auth/{id}", get(admin::get_device_auth))
        .route("/device-auth/{id}/approve", post(admin::approve_device_auth))
        .route("/device-auth/{id}/deny", post(admin::deny_device_auth))
        .route("/tenants/{id}/dns", get(admin::get_tenant_dns).put(admin::set_tenant_dns))
        .route(
            "/tenants/{id}/access",
            get(admin::get_tenant_access).put(admin::set_tenant_access),
        )
        .route(
            "/tenants/{id}/identity",
            get(admin::get_tenant_identity).put(admin::set_tenant_identity),
        )
        .route("/preauth-keys", post(admin::create_preauth_key))
        .route("/nodes", get(admin::list_nodes))
        .route("/nodes/{id}", get(admin::get_node_handler).delete(admin::delete_node_handler))
        .route("/nodes/{id}/name", post(admin::rename_node_handler))
        .route("/acl", post(admin::set_acl))
        .layer(middleware::from_fn_with_state(state.clone(), require_admin_auth));

    let federation_routes = Router::new()
        .route("/hello", post(federation::handle_hello))
        .route("/commit", post(federation::handle_commit))
        .route("/keepalive", post(federation::handle_keepalive))
        .route("/revoke", post(federation::handle_revoke))
        .route("/link-request", post(federation::handle_link_request))
        .route("/link-accept", post(federation::handle_link_accept))
        .route("/link-reject", post(federation::handle_link_reject))
        .route("/link-revoke", post(federation::handle_link_revoke));

    // A process serves the parts of its role (ADR-0034)
    let role = state.role();
    let mut app = Router::new().route("/health", get(health));
    if role.serves_relay() {
        // Built-in DERP relay (ADR-0027)
        app = app
            .route("/derp", get(derp_handler::derp_handler))
            .route("/derp/probe", get(derp_handler::probe_handler))
            .route("/derp/latency-check", get(derp_handler::probe_handler))
            .route("/generate_204", get(derp_handler::generate_204_handler));
    }
    if role.serves_control() {
        app = app
            .route("/key", get(key_handler::key_handler))
            .route("/ts2021", post(noise_handler::ts2021_handler))
            .nest("/api", admin_routes);
        if state.federation_enabled() {
            app = app.nest("/api/federation/messages", federation_routes);
        }
    }
    app.layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .with_state(state)
}

/// Ephemeral nodes offline at least this long are deleted by the sweeper.
pub const EPHEMERAL_OFFLINE_GRACE: std::time::Duration = std::time::Duration::from_secs(5 * 60);
/// How often the ephemeral sweeper runs.
pub const EPHEMERAL_SWEEP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

/// Delete ephemeral nodes that have been offline for at least `max_offline`.
/// Returns the number of nodes removed (their peers get PeersRemoved deltas).
pub async fn sweep_ephemeral_nodes(state: &Arc<CoordinatorState>, max_offline: std::time::Duration) -> usize {
    let max_offline = chrono::Duration::from_std(max_offline).unwrap_or(chrono::Duration::MAX);
    match state.store.delete_stale_ephemeral_nodes(max_offline).await {
        Ok(removed) => {
            if !removed.is_empty() {
                tracing::info!(count = removed.len(), "swept offline ephemeral nodes");
            }
            removed.len()
        }
        Err(e) => {
            tracing::warn!(error = %e, "ephemeral node sweep failed");
            0
        }
    }
}

/// Spawn the background task that sweeps offline ephemeral nodes every minute.
pub fn spawn_ephemeral_sweeper(state: Arc<CoordinatorState>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(EPHEMERAL_SWEEP_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            sweep_ephemeral_nodes(&state, EPHEMERAL_OFFLINE_GRACE).await;
        }
    })
}

/// Changes on every process start so the service can detect a restart and resync in-memory state.
static BOOT_ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();

async fn health() -> axum::Json<serde_json::Value> {
    let boot_id = BOOT_ID.get_or_init(|| uuid::Uuid::new_v4().to_string());
    axum::Json(serde_json::json!({"status": "ok", "boot_id": boot_id}))
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

/// Drive `/machine/map` (streaming or not) as the Noise H2 server would; the
/// body yields length-prefixed zstd frames.
#[doc(hidden)]
pub async fn __test_map_request(
    state: Arc<CoordinatorState>,
    machine_key: [u8; 32],
    body: &str,
) -> axum::http::Response<http_body_util::combinators::BoxBody<bytes::Bytes, std::io::Error>> {
    noise_handler::handle_map_request(state, machine_key, body).await
}

/// Serve the Noise-side control HTTP/2 protocol over an arbitrary stream
/// (tests drive it over an in-memory duplex without the Noise layer).
#[doc(hidden)]
pub async fn __test_serve_control_h2(
    state: Arc<CoordinatorState>,
    io: tokio::io::DuplexStream,
    machine_key: [u8; 32],
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    noise_handler::serve_control_h2(state, io, machine_key).await
}

pub use noise_handler::{MAX_CONCURRENT_STREAMS, MAX_CONTROL_BODY};
pub use state::DEFAULT_MAX_NOISE_CONNECTIONS;
