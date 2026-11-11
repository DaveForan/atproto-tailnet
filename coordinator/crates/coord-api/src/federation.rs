use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use coord_core::types::TenantId;
use coord_federation::{
    protocol::{
        CommitMessage, HelloMessage, KeepaliveMessage, LinkAcceptMessage, LinkRejectMessage,
        LinkRequestMessage, LinkRevokeMessage, RevokeMessage,
    },
    InboundError,
};

use crate::state::CoordinatorState;

const CFP_RECIPIENT: &str = "CFP-Recipient";

fn inbound_error_response(err: InboundError) -> impl IntoResponse {
    let status = match err.status_code() {
        400 => StatusCode::BAD_REQUEST,
        403 => StatusCode::FORBIDDEN,
        404 => StatusCode::NOT_FOUND,
        409 => StatusCode::CONFLICT,
        410 => StatusCode::GONE,
        429 => StatusCode::TOO_MANY_REQUESTS,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (status, Json(serde_json::json!({ "error": err.message() })))
}

async fn resolve_recipient(
    state: &CoordinatorState,
    headers: &HeaderMap,
) -> Result<(TenantId, String), impl IntoResponse> {
    let recipient_did = headers
        .get(CFP_RECIPIENT)
        .and_then(|v| v.to_str().ok())
        .filter(|v| v.len() <= 512);

    let recipient_did = match recipient_did {
        Some(d) => d.to_string(),
        None => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "CFP-Recipient header required" })),
            ));
        }
    };

    let handler = &state.federation_inbound;
    let tenant_id = handler
        .store()
        .find_tenant_by_did(&recipient_did)
        .await
        .ok()
        .flatten();

    match tenant_id {
        Some(tid) => Ok((tid, recipient_did)),
        None => Err((
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Unknown recipient collective" })),
        )),
    }
}

fn require_callbacks(
    state: &CoordinatorState,
) -> Result<&dyn coord_federation::HandshakeCallbacks, impl IntoResponse> {
    match &state.federation_callbacks {
        Some(cb) => Ok(cb.as_ref()),
        None => Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "error": "Federation handshake not configured" })),
        )),
    }
}

pub async fn handle_hello(
    State(state): State<Arc<CoordinatorState>>,
    headers: HeaderMap,
    Json(hello): Json<HelloMessage>,
) -> impl IntoResponse {
    let (tenant_id, recipient_did) = match resolve_recipient(&state, &headers).await {
        Ok(r) => r,
        Err(e) => return e.into_response(),
    };

    let callbacks = match require_callbacks(&state) {
        Ok(cb) => cb,
        Err(e) => return e.into_response(),
    };
    match state
        .federation_inbound
        .handle_hello(tenant_id, &recipient_did, hello, callbacks)
        .await
    {
        Ok(challenge) => (StatusCode::OK, Json(challenge)).into_response(),
        Err(e) => inbound_error_response(e).into_response(),
    }
}

pub async fn handle_commit(
    State(state): State<Arc<CoordinatorState>>,
    headers: HeaderMap,
    Json(commit): Json<CommitMessage>,
) -> impl IntoResponse {
    let (tenant_id, _recipient_did) = match resolve_recipient(&state, &headers).await {
        Ok(r) => r,
        Err(e) => return e.into_response(),
    };

    let callbacks = match require_callbacks(&state) {
        Ok(cb) => cb,
        Err(e) => return e.into_response(),
    };
    match state
        .federation_inbound
        .handle_commit(tenant_id, commit, callbacks)
        .await
    {
        Ok(established) => (StatusCode::OK, Json(established)).into_response(),
        Err(e) => inbound_error_response(e).into_response(),
    }
}

pub async fn handle_keepalive(
    State(state): State<Arc<CoordinatorState>>,
    headers: HeaderMap,
    Json(keepalive): Json<KeepaliveMessage>,
) -> impl IntoResponse {
    let (tenant_id, _recipient_did) = match resolve_recipient(&state, &headers).await {
        Ok(r) => r,
        Err(e) => return e.into_response(),
    };

    let callbacks = match require_callbacks(&state) {
        Ok(cb) => cb,
        Err(e) => return e.into_response(),
    };
    match state
        .federation_inbound
        .handle_keepalive(tenant_id, keepalive, callbacks)
        .await
    {
        Ok(ack) => (StatusCode::OK, Json(ack)).into_response(),
        Err(e) => inbound_error_response(e).into_response(),
    }
}

pub async fn handle_revoke(
    State(state): State<Arc<CoordinatorState>>,
    headers: HeaderMap,
    Json(revoke): Json<RevokeMessage>,
) -> impl IntoResponse {
    let (tenant_id, _recipient_did) = match resolve_recipient(&state, &headers).await {
        Ok(r) => r,
        Err(e) => return e.into_response(),
    };

    let callbacks = match require_callbacks(&state) {
        Ok(cb) => cb,
        Err(e) => return e.into_response(),
    };
    match state
        .federation_inbound
        .handle_revoke(tenant_id, revoke, callbacks)
        .await
    {
        Ok(()) => (
            StatusCode::OK,
            Json(serde_json::json!({ "status": "revoked" })),
        )
            .into_response(),
        Err(e) => inbound_error_response(e).into_response(),
    }
}

pub async fn handle_link_request(
    State(state): State<Arc<CoordinatorState>>,
    headers: HeaderMap,
    Json(msg): Json<LinkRequestMessage>,
) -> impl IntoResponse {
    let (tenant_id, _recipient_did) = match resolve_recipient(&state, &headers).await {
        Ok(r) => r,
        Err(e) => return e.into_response(),
    };

    let callbacks = match require_callbacks(&state) {
        Ok(cb) => cb,
        Err(e) => return e.into_response(),
    };
    match state
        .federation_inbound
        .handle_link_request(tenant_id, msg, callbacks)
        .await
    {
        Ok(()) => (
            StatusCode::CREATED,
            Json(serde_json::json!({ "status": "queued" })),
        )
            .into_response(),
        Err(e) => inbound_error_response(e).into_response(),
    }
}

pub async fn handle_link_accept(
    State(state): State<Arc<CoordinatorState>>,
    headers: HeaderMap,
    Json(msg): Json<LinkAcceptMessage>,
) -> impl IntoResponse {
    let (tenant_id, _recipient_did) = match resolve_recipient(&state, &headers).await {
        Ok(r) => r,
        Err(e) => return e.into_response(),
    };

    let callbacks = match require_callbacks(&state) {
        Ok(cb) => cb,
        Err(e) => return e.into_response(),
    };
    match state
        .federation_inbound
        .handle_link_accept(tenant_id, msg, callbacks)
        .await
    {
        Ok(()) => (
            StatusCode::OK,
            Json(serde_json::json!({ "status": "accepted" })),
        )
            .into_response(),
        Err(e) => inbound_error_response(e).into_response(),
    }
}

pub async fn handle_link_reject(
    State(state): State<Arc<CoordinatorState>>,
    headers: HeaderMap,
    Json(msg): Json<LinkRejectMessage>,
) -> impl IntoResponse {
    let (tenant_id, _recipient_did) = match resolve_recipient(&state, &headers).await {
        Ok(r) => r,
        Err(e) => return e.into_response(),
    };

    let callbacks = match require_callbacks(&state) {
        Ok(cb) => cb,
        Err(e) => return e.into_response(),
    };
    match state
        .federation_inbound
        .handle_link_reject(tenant_id, msg, callbacks)
        .await
    {
        Ok(()) => (
            StatusCode::OK,
            Json(serde_json::json!({ "status": "rejected" })),
        )
            .into_response(),
        Err(e) => inbound_error_response(e).into_response(),
    }
}

pub async fn handle_link_revoke(
    State(state): State<Arc<CoordinatorState>>,
    headers: HeaderMap,
    Json(msg): Json<LinkRevokeMessage>,
) -> impl IntoResponse {
    let (tenant_id, _recipient_did) = match resolve_recipient(&state, &headers).await {
        Ok(r) => r,
        Err(e) => return e.into_response(),
    };

    let callbacks = match require_callbacks(&state) {
        Ok(cb) => cb,
        Err(e) => return e.into_response(),
    };
    match state
        .federation_inbound
        .handle_link_revoke(tenant_id, msg, callbacks)
        .await
    {
        Ok(()) => (
            StatusCode::OK,
            Json(serde_json::json!({ "status": "revoked" })),
        )
            .into_response(),
        Err(e) => inbound_error_response(e).into_response(),
    }
}
