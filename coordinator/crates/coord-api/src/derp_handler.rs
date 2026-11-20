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
/// suspended. The scope is the node's tenant, plus the link to its parent
/// only while the netmap would show the child to the parent (see
/// [`relay_scope`]).
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
        relay_scope(&self.store, detail.tenant_id).await
    }
}

/// The relay scope of a tenant's nodes, or `None` when the tenant is missing
/// or suspended. Cross-tenant relaying follows the same rule as peers in the
/// netmap: a child is linked to its parent only when its posture is not
/// Closed and neither the child nor the parent is suspended. Without the
/// link, neither side reaches the other (`Scope::can_reach`).
pub async fn relay_scope(store: &Store, tenant_id: coord_core::TenantId) -> Option<Scope> {
    let tenant = store.get_tenant(tenant_id).await?;
    if tenant.suspended {
        return None;
    }
    let parent = match tenant.parent_id {
        Some(p) if tenant.visible_to_parent() && !store.is_tenant_suspended(p).await => Some(*p.as_uuid().as_bytes()),
        _ => None,
    };
    Some(Scope { tenant: *tenant.id.as_uuid().as_bytes(), parent })
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

#[cfg(test)]
mod tests {
    use super::*;
    use coord_core::FederationPosture;

    #[tokio::test]
    async fn parent_link_follows_posture_and_suspension() {
        let store = Store::Memory(Box::new(coord_store::MemoryStore::new()));
        let parent = store.create_tenant("p".into(), None, None).await.unwrap().id;
        let child = store.create_tenant("c".into(), Some(parent), Some(FederationPosture::Open)).await.unwrap().id;
        let pb = *parent.as_uuid().as_bytes();

        assert_eq!(relay_scope(&store, child).await.unwrap().parent, Some(pb));
        assert_eq!(relay_scope(&store, parent).await.unwrap().parent, None);

        store.update_tenant_posture(child, FederationPosture::Selective).await.unwrap();
        assert_eq!(relay_scope(&store, child).await.unwrap().parent, Some(pb));

        // Closed: no link, so neither side reaches the other
        store.update_tenant_posture(child, FederationPosture::Closed).await.unwrap();
        let closed = relay_scope(&store, child).await.unwrap();
        assert_eq!(closed.parent, None);
        assert!(!closed.can_reach(&relay_scope(&store, parent).await.unwrap()));
        assert!(!relay_scope(&store, parent).await.unwrap().can_reach(&closed));

        // Suspended parent: the parent is refused and the child loses the link
        store.update_tenant_posture(child, FederationPosture::Open).await.unwrap();
        store.set_tenant_suspended(parent, true).await.unwrap();
        assert!(relay_scope(&store, parent).await.is_none());
        assert_eq!(relay_scope(&store, child).await.unwrap().parent, None);

        // Suspended child: refused outright
        store.set_tenant_suspended(parent, false).await.unwrap();
        store.set_tenant_suspended(child, true).await.unwrap();
        assert!(relay_scope(&store, child).await.is_none());
    }
}
