//! HTTP side of the built-in DERP relay (ADR-0027): the `/derp` upgrade and
//! the small probe endpoints Tailscale clients call.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, Request, StatusCode, header};
use axum::response::{IntoResponse, Response};
use coord_derp::{Admission, Scope};
use coord_store::Store;
use tracing::{debug, warn};

use crate::state::CoordinatorState;

/// Admits nodes registered with this coordinator whose tenant is not
/// suspended. The scope is the node's tenant and that tenant's parent.
pub struct StoreAdmission {
    pub(crate) store: Arc<Store>,
}

impl StoreAdmission {
    pub fn for_state(state: &CoordinatorState) -> Self {
        Self { store: state.store.clone() }
    }
}

#[async_trait::async_trait]
impl Admission for StoreAdmission {
    async fn admit(&self, node_key: &[u8; 32]) -> Option<Scope> {
        let node = self.store.get_node_by_node_key(node_key).await?;
        let detail = self.store.get_node_info(node).await?;
        if self.store.is_tenant_suspended(detail.tenant_id).await {
            return None;
        }
        let tenant = self.store.get_tenant(detail.tenant_id).await?;
        Some(Scope {
            tenant: *tenant.id.as_uuid().as_bytes(),
            parent: tenant.parent_id.map(|p| *p.as_uuid().as_bytes()),
        })
    }
}

/// `GET /derp` with `Upgrade: DERP` — hands the connection to the relay.
pub async fn derp_handler(State(state): State<Arc<CoordinatorState>>, req: Request<Body>) -> Response {
    let upgrade = req
        .headers()
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    // The WebSocket transport (browser clients) is not implemented.
    if upgrade != "derp" {
        return (StatusCode::UPGRADE_REQUIRED, "DERP requires connection upgrade").into_response();
    }

    let relay = state.relay.clone();
    let public_key = hex::encode(relay.public_key());
    let on_upgrade = hyper::upgrade::on(req);
    tokio::spawn(async move {
        match on_upgrade.await {
            Ok(upgraded) => {
                if let Err(e) = relay.serve_conn(hyper_util::rt::TokioIo::new(upgraded)).await {
                    debug!(error = %e, "derp connection ended");
                }
            }
            Err(e) => warn!(error = %e, "derp upgrade failed"),
        }
    });

    Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header(header::UPGRADE, "DERP")
        .header(header::CONNECTION, "Upgrade")
        .header("Derp-Version", coord_derp::frame::PROTOCOL_VERSION.to_string())
        .header("Derp-Public-Key", public_key)
        .body(Body::empty())
        .unwrap()
}

/// `/derp/probe` and `/derp/latency-check` — clients time this request to
/// pick the closest relay when UDP is blocked.
pub async fn probe_handler() -> impl IntoResponse {
    [(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")]
}

/// `/generate_204` — captive-portal detection. A client sends a challenge and
/// expects it echoed, which a captive portal's fake page cannot do.
pub async fn generate_204_handler(headers: HeaderMap) -> Response {
    let mut resp = Response::builder()
        .status(StatusCode::NO_CONTENT)
        .header(header::CACHE_CONTROL, "no-cache, no-store, must-revalidate, no-transform, max-age=0");
    if let Some(challenge) = headers.get("X-Tailscale-Challenge").and_then(|v| v.to_str().ok()) {
        let valid = !challenge.is_empty()
            && challenge.len() <= 64
            && challenge.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b':'));
        if valid {
            resp = resp.header("X-Tailscale-Response", format!("response {challenge}"));
        }
    }
    resp.body(Body::empty()).unwrap()
}
