use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use coord_core::{NodeId, TenantId};
use tracing::error;
use crate::state::CoordinatorState;
use coord_core::{is_valid_slug, is_valid_hostname};

fn internal_error(e: impl std::fmt::Display) -> impl IntoResponse {
    error!(error = %e, "internal error");
    (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "internal error"})))
}

// ── Tenant management ──

#[derive(Deserialize)]
pub struct CreateTenantRequest {
    pub slug: String,
    pub parent_id: Option<String>,
    pub federation_posture: Option<String>,
}

#[derive(Serialize)]
pub struct TenantResponse {
    pub id: String,
    pub slug: String,
    pub parent_id: Option<String>,
    pub federation_posture: String,
    pub ipv4_prefix: String,
    pub ipv6_prefix: String,
    pub created_at: String,
    pub suspended: bool,
}

impl From<coord_core::Tenant> for TenantResponse {
    fn from(t: coord_core::Tenant) -> Self {
        Self {
            id: t.id.to_string(),
            slug: t.slug,
            parent_id: t.parent_id.map(|p| p.to_string()),
            federation_posture: t.federation_posture.as_str().to_string(),
            ipv4_prefix: t.ipv4_prefix,
            ipv6_prefix: t.ipv6_prefix,
            created_at: t.created_at.to_rfc3339(),
            suspended: t.suspended,
        }
    }
}

pub async fn create_tenant(
    State(state): State<Arc<CoordinatorState>>,
    Json(body): Json<CreateTenantRequest>,
) -> impl IntoResponse {
    if !is_valid_slug(&body.slug) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "invalid slug: must match ^[a-z0-9][a-z0-9-]{0,62}$"})),
        ).into_response();
    }

    let parent_id = match &body.parent_id {
        Some(id) => match id.parse::<uuid::Uuid>() {
            Ok(uuid) => Some(TenantId::new(uuid)),
            Err(_) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"error": "invalid parent_id"})),
                ).into_response();
            }
        },
        None => None,
    };

    let posture = match &body.federation_posture {
        Some(p) => match p.parse::<coord_core::FederationPosture>() {
            Ok(fp) => Some(fp),
            Err(_) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"error": "invalid federation_posture: must be open, selective, or closed"})),
                ).into_response();
            }
        },
        None => None,
    };

    match state.store.create_tenant(body.slug, parent_id, posture).await {
        Ok(tenant) => (
            StatusCode::CREATED,
            Json(serde_json::json!(TenantResponse::from(tenant))),
        ).into_response(),
        Err(coord_core::CoordError::TenantNotFound(_)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "parent tenant not found"})),
        ).into_response(),
        Err(coord_core::CoordError::Protocol(ref msg)) if msg.contains("already exists") => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({"error": msg.clone()})),
        ).into_response(),
        Err(coord_core::CoordError::Protocol(ref msg)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": msg.clone()})),
        ).into_response(),
        Err(e) => {
            error!(error = %e, "tenant creation failed");
            internal_error(e).into_response()
        }
    }
}

pub async fn list_tenants(
    State(state): State<Arc<CoordinatorState>>,
) -> impl IntoResponse {
    let tenants = state.store.list_tenants().await;
    let responses: Vec<TenantResponse> = tenants.into_iter().map(TenantResponse::from).collect();
    Json(serde_json::json!({
        "tenants": responses,
        "count": responses.len(),
    }))
}

pub async fn get_tenant(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let tenant_id = match id.parse::<uuid::Uuid>() {
        Ok(uuid) => TenantId::new(uuid),
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "invalid tenant_id"})),
            ).into_response();
        }
    };

    match state.store.get_tenant(tenant_id).await {
        Some(tenant) => {
            let children = state.store.get_child_tenants(tenant_id).await;
            let child_responses: Vec<TenantResponse> = children.into_iter().map(TenantResponse::from).collect();
            Json(serde_json::json!({
                "tenant": TenantResponse::from(tenant),
                "children": child_responses,
            })).into_response()
        }
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "tenant not found"})),
        ).into_response(),
    }
}

pub async fn delete_tenant(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let tenant_id = match id.parse::<uuid::Uuid>() {
        Ok(uuid) => TenantId::new(uuid),
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "invalid tenant_id"})),
            ).into_response();
        }
    };

    match state.store.delete_tenant(tenant_id).await {
        Ok(()) => {
            // Clean up any ACL policy for the deleted tenant
            // The stored configuration went with the tenant row; drop the caches here and on other replicas
            state.forget_tenant_config(tenant_id);
            state.notify_tenant_changed(tenant_id);
            (
                StatusCode::OK,
                Json(serde_json::json!({"status": "deleted", "tenant_id": id})),
            ).into_response()
        }
        Err(coord_core::CoordError::TenantNotFound(_)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "tenant not found"})),
        ).into_response(),
        Err(coord_core::CoordError::Protocol(ref msg)) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({"error": msg.clone()})),
        ).into_response(),
        Err(e) => internal_error(e).into_response(),
    }
}

// ── Tenant posture management ──

#[derive(Deserialize)]
pub struct UpdatePostureRequest {
    pub posture: String,
}

pub async fn update_tenant_posture(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
    Json(body): Json<UpdatePostureRequest>,
) -> impl IntoResponse {
    let tenant_id = match id.parse::<uuid::Uuid>() {
        Ok(uuid) => TenantId::new(uuid),
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "invalid tenant_id"})),
            ).into_response();
        }
    };

    let posture: coord_core::FederationPosture = match body.posture.parse() {
        Ok(p) => p,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "invalid posture: must be open, selective, or closed"})),
            ).into_response();
        }
    };

    match state.store.update_tenant_posture(tenant_id, posture).await {
        Ok(tenant) => {
            if let Some(parent) = tenant.parent_id {
                state.notify_tenant_changed(parent);
            }
            Json(serde_json::json!(TenantResponse::from(tenant))).into_response()
        }
        Err(e) => internal_error(e).into_response(),
    }
}

#[derive(Deserialize)]
pub struct SetSuspendedRequest {
    pub suspended: bool,
}

/// PUT /api/tenants/{id}/suspended — instance-operator suspension. While
/// suspended the tenant's nodes cannot register or poll the map, and live map
/// streams end (via the config_changed broadcast, which re-checks suspension).
pub async fn set_tenant_suspended(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
    Json(body): Json<SetSuspendedRequest>,
) -> impl IntoResponse {
    let Some(tenant_id) = parse_tenant_id(&id) else {
        return bad_request("invalid tenant_id");
    };
    match state.store.set_tenant_suspended(tenant_id, body.suspended).await {
        Ok(tenant) => {
            tracing::info!(tenant = %tenant_id, suspended = body.suspended, "tenant suspension changed");
            state.notify_tenant_changed(tenant_id);
            if let Some(parent) = tenant.parent_id {
                state.notify_tenant_changed(parent);
            }
            Json(serde_json::json!(TenantResponse::from(tenant))).into_response()
        }
        Err(coord_core::CoordError::TenantNotFound(_)) => not_found("tenant not found"),
        Err(e) => internal_error(e).into_response(),
    }
}

// ── Preauth key management ──

/// Upper bound for `expiration_seconds` (one year).
const MAX_KEY_EXPIRATION_SECS: u64 = 31_536_000;

#[derive(Deserialize)]
pub struct CreateKeyRequest {
    pub tenant_id: String,
    pub reusable: Option<bool>,
    pub ephemeral: Option<bool>,
    pub expiration_seconds: Option<u64>,
    pub owner: Option<String>,
    pub tags: Option<Vec<String>>,
}

#[derive(Serialize)]
pub struct CreateKeyResponse {
    pub key: String,
    pub id: String,
    pub tenant_id: String,
    pub expires_at: Option<String>,
}

fn validate_owner(owner: &str) -> Result<(), String> {
    if owner.is_empty() || owner.chars().count() > coord_core::routes::MAX_OWNER_LEN {
        return Err(format!("owner must be 1-{} characters", coord_core::routes::MAX_OWNER_LEN));
    }
    Ok(())
}

fn validate_tags(tags: Vec<String>) -> Result<Vec<String>, String> {
    if tags.len() > coord_core::routes::MAX_TAGS {
        return Err(format!("at most {} tags allowed", coord_core::routes::MAX_TAGS));
    }
    if let Some(bad) = tags.iter().find(|t| !coord_core::routes::is_valid_tag(t)) {
        return Err(format!("invalid tag {bad:?}: must match ^tag:[a-z0-9-]{{1,63}}$"));
    }
    let mut tags = tags;
    tags.sort();
    tags.dedup();
    Ok(tags)
}

pub async fn create_preauth_key(
    State(state): State<Arc<CoordinatorState>>,
    Json(body): Json<CreateKeyRequest>,
) -> impl IntoResponse {
    let tenant_id = match body.tenant_id.parse::<uuid::Uuid>() {
        Ok(uuid) => {
            let tid = TenantId::new(uuid);
            match state.store.get_tenant(tid).await {
                None => {
                    return (
                        StatusCode::NOT_FOUND,
                        Json(serde_json::json!({"error": "tenant not found — create it first via POST /api/tenants"})),
                    ).into_response();
                }
                Some(t) if t.suspended => {
                    return (
                        StatusCode::CONFLICT,
                        Json(serde_json::json!({"error": "tenant is suspended", "code": "tenant_suspended"})),
                    ).into_response();
                }
                Some(_) => {}
            }
            tid
        }
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "invalid tenant_id"})),
            ).into_response();
        }
    };

    let expires_at = match body.expiration_seconds {
        None => None,
        Some(secs) if (1..=MAX_KEY_EXPIRATION_SECS).contains(&secs) => {
            // Whole seconds so every backend compares expiry identically.
            let at = chrono::Utc::now().timestamp() + secs as i64;
            chrono::DateTime::from_timestamp(at, 0)
        }
        Some(_) => {
            return bad_request(format!("expiration_seconds must be 1..={MAX_KEY_EXPIRATION_SECS}"));
        }
    };
    if let Some(owner) = &body.owner {
        if let Err(e) = validate_owner(owner) {
            return bad_request(e);
        }
    }
    let tags = match validate_tags(body.tags.unwrap_or_default()) {
        Ok(t) => t,
        Err(e) => return bad_request(e),
    };

    let opts = coord_core::PreAuthKeyOptions {
        reusable: body.reusable.unwrap_or(false),
        ephemeral: body.ephemeral.unwrap_or(false),
        expires_at,
        owner: body.owner,
        tags,
    };
    let created = match state.store.create_preauth_key_with(tenant_id, opts).await {
        Ok(k) => k,
        Err(e) => {
            return internal_error(e).into_response();
        }
    };

    (
        StatusCode::CREATED,
        Json(CreateKeyResponse {
            key: created.key,
            id: created.id.to_string(),
            tenant_id: tenant_id.to_string(),
            expires_at: created.expires_at.map(|t| t.to_rfc3339()),
        }),
    )
        .into_response()
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

fn required_owner(query: OwnerQuery) -> Result<String, axum::response::Response> {
    let Some(owner) = query.owner else {
        return Err(bad_request("owner query parameter is required"));
    };
    validate_owner(&owner).map_err(bad_request)?;
    Ok(owner)
}

/// GET /api/tenants/{id}/preauth-keys — never exposes the full key.
pub async fn list_preauth_keys(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let tenant_id = match existing_tenant(&state, &id).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    let keys: Vec<serde_json::Value> = state
        .store
        .list_preauth_keys(tenant_id)
        .await
        .into_iter()
        .map(|k| {
            serde_json::json!({
                "id": k.id.to_string(),
                "prefix": k.prefix,
                "owner": k.owner,
                "tags": k.tags,
                "reusable": k.reusable,
                "ephemeral": k.ephemeral,
                "used": k.used,
                "expires_at": k.expires_at.map(|t| t.to_rfc3339()),
                "created_at": k.created_at.to_rfc3339(),
                "revoked": k.revoked,
            })
        })
        .collect();
    Json(serde_json::json!({"keys": keys})).into_response()
}

/// DELETE /api/tenants/{id}/preauth-keys/{key_id}
pub async fn revoke_preauth_key(
    State(state): State<Arc<CoordinatorState>>,
    Path((id, key_id)): Path<(String, String)>,
) -> impl IntoResponse {
    let tenant_id = match existing_tenant(&state, &id).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    let Ok(key_id) = key_id.parse::<uuid::Uuid>() else {
        return not_found("key not found");
    };
    match state.store.revoke_preauth_key(tenant_id, key_id).await {
        Ok(true) => Json(serde_json::json!({"status": "revoked"})).into_response(),
        Ok(false) => not_found("key not found"),
        Err(e) => internal_error(e).into_response(),
    }
}

/// DELETE /api/tenants/{id}/preauth-keys?owner=X
pub async fn revoke_preauth_keys_by_owner(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
    Query(query): Query<OwnerQuery>,
) -> impl IntoResponse {
    let tenant_id = match existing_tenant(&state, &id).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    let owner = match required_owner(query) {
        Ok(o) => o,
        Err(r) => return r,
    };
    match state.store.revoke_preauth_keys_by_owner(tenant_id, &owner).await {
        Ok(n) => Json(serde_json::json!({"revoked": n})).into_response(),
        Err(e) => internal_error(e).into_response(),
    }
}

/// DELETE /api/tenants/{id}/nodes?owner=X — deleting a node ends its map stream.
pub async fn delete_tenant_nodes_by_owner(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
    Query(query): Query<OwnerQuery>,
) -> impl IntoResponse {
    let tenant_id = match existing_tenant(&state, &id).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    let owner = match required_owner(query) {
        Ok(o) => o,
        Err(r) => return r,
    };
    match state.store.delete_nodes_by_owner(tenant_id, &owner).await {
        Ok(ids) => {
            tracing::info!(tenant = %tenant_id, deleted = ids.len(), "deleted nodes by owner");
            Json(serde_json::json!({"deleted": ids.len()})).into_response()
        }
        Err(e) => internal_error(e).into_response(),
    }
}

#[derive(Deserialize)]
pub struct ApproveRoutesRequest {
    pub approved: Vec<String>,
}

/// POST /api/tenants/{id}/nodes/{node_id}/routes — the only manual approval path.
pub async fn approve_node_routes(
    State(state): State<Arc<CoordinatorState>>,
    Path((id, node_id)): Path<(String, String)>,
    Json(body): Json<ApproveRoutesRequest>,
) -> impl IntoResponse {
    let tenant_id = match existing_tenant(&state, &id).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    let Ok(node_id) = node_id.parse::<i64>().map(NodeId::new) else {
        return bad_request("invalid node_id");
    };
    let approved = match coord_core::routes::normalize_routes_strict(&body.approved) {
        Ok(r) => r,
        Err(bad) => return bad_request(format!("invalid CIDR: {bad}")),
    };
    let Some(detail) = state.store.get_node_info(node_id).await.filter(|d| d.tenant_id == tenant_id) else {
        return not_found("node not found");
    };
    if let Some(bad) = approved.iter().find(|r| !detail.attrs.advertised_routes.contains(r)) {
        return bad_request(format!("route {bad} is not advertised by this node"));
    }
    match state.store.set_approved_routes(node_id, approved).await {
        Ok(changed) => {
            if changed {
                state.notify_tenant_changed(tenant_id);
            }
        }
        Err(coord_core::CoordError::Protocol(ref msg)) if msg.contains("not found") => {
            return not_found("node not found");
        }
        Err(e) => return internal_error(e).into_response(),
    }
    match state.store.get_node_info(node_id).await {
        Some(detail) => Json(node_detail_json(node_id, detail)).into_response(),
        None => not_found("node not found"),
    }
}

/// GET /api/tenants/{id}/identity
pub async fn get_tenant_identity(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let tenant_id = match existing_tenant(&state, &id).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    Json(state.identity.get_tenant(tenant_id)).into_response()
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
    let changed = state.identity.get_tenant(tenant_id) != identity;
    if let Err(r) = state.save_config(tenant_id, crate::state::CONFIG_IDENTITY, &identity).await {
        return r;
    }
    state.identity.set_tenant(tenant_id, identity.clone());
    if changed {
        state.notify_tenant_changed(tenant_id);
    }
    Json(identity).into_response()
}

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

#[derive(serde::Deserialize)]
pub struct OwnerLockBody {
    /// Nodes of the owner that stay allowed.
    pub node_ids: Vec<i64>,
    /// Most machines the lock may hold (absent = the system limit).
    #[serde(default)]
    pub max_machines: Option<u32>,
}

#[derive(serde::Deserialize)]
pub struct RefusedQuery {
    /// Only attempts after this time.
    pub since: Option<chrono::DateTime<chrono::Utc>>,
}

/// GET /api/owner-locks/refused?since=… — machines refused by a machine lock,
/// oldest first, for the TS service to notify their owners.
pub async fn list_refused_machines(
    State(state): State<Arc<CoordinatorState>>,
    axum::extract::Query(q): axum::extract::Query<RefusedQuery>,
) -> impl IntoResponse {
    let mut out = Vec::new();
    for (tenant_id, owner, lock) in state.store.list_owner_locks().await {
        for r in lock.refused.into_iter().filter(|r| q.since.is_none_or(|s| r.at > s)) {
            out.push((r.at, serde_json::json!({
                "tenant_id": tenant_id.to_string(),
                "owner": owner,
                "at": r.at,
                "hostname": r.hostname,
                "os": r.os,
                "fingerprint": r.fingerprint,
            })));
        }
    }
    out.sort_by_key(|(at, _)| *at);
    Json(serde_json::json!({ "refused": out.into_iter().map(|(_, v)| v).collect::<Vec<_>>() })).into_response()
}

#[derive(serde::Deserialize)]
pub struct AllowOneBody {
    pub seconds: i64,
}

fn valid_owner(owner: &str) -> bool {
    !owner.is_empty() && owner.len() <= 128
}

async fn owner_lock_view(state: &CoordinatorState, tenant_id: TenantId, owner: &str) -> serde_json::Value {
    let lock = state.store.get_owner_lock(tenant_id, owner).await;
    let nodes = state.store.list_tenant_nodes(tenant_id).await;
    let allowed: Vec<i64> = match &lock {
        Some(l) => nodes
            .iter()
            .filter(|n| n.owner.as_deref() == Some(owner) && l.allows(&hex::encode(&n.machine_key)))
            .map(|n| n.node_id.as_i64())
            .collect(),
        None => vec![],
    };
    serde_json::json!({
        "locked": lock.is_some(),
        "node_ids": allowed,
        "allow_one_until": lock.as_ref().and_then(|l| l.allow_one_until),
        "max_machines": lock.as_ref().and_then(|l| l.max_machines),
        "refused": lock.map(|l| l.refused).unwrap_or_default(),
    })
}

/// GET /api/tenants/{id}/owner-locks/{owner}
pub async fn get_owner_lock(
    State(state): State<Arc<CoordinatorState>>,
    Path((id, owner)): Path<(String, String)>,
) -> impl IntoResponse {
    let tenant_id = match existing_tenant(&state, &id).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    Json(owner_lock_view(&state, tenant_id, &owner).await).into_response()
}

/// PUT /api/tenants/{id}/owner-locks/{owner} — lock the owner to the machines
/// of the given nodes. The owner's other nodes are removed from the tenant:
/// a lock that left them connected would not mean what it says.
pub async fn set_owner_lock(
    State(state): State<Arc<CoordinatorState>>,
    Path((id, owner)): Path<(String, String)>,
    Json(body): Json<OwnerLockBody>,
) -> impl IntoResponse {
    let tenant_id = match existing_tenant(&state, &id).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    if !valid_owner(&owner) || body.node_ids.len() > coord_core::lock::MAX_LOCK_MACHINES {
        return bad_request("invalid owner or too many devices".to_string());
    }
    let owned: Vec<_> = state
        .store
        .list_tenant_nodes(tenant_id)
        .await
        .into_iter()
        .filter(|n| n.owner.as_deref() == Some(owner.as_str()))
        .collect();
    if let Some(bad) = body.node_ids.iter().find(|id| !owned.iter().any(|n| n.node_id.as_i64() == **id)) {
        return bad_request(format!("node {bad} is not a device of this owner in this tenant"));
    }
    let machines: Vec<String> = owned
        .iter()
        .filter(|n| body.node_ids.contains(&n.node_id.as_i64()))
        .map(|n| hex::encode(&n.machine_key))
        .collect();
    if let Some(max) = body.max_machines {
        if max < 1 || max as usize > coord_core::lock::MAX_LOCK_MACHINES || (max as usize) < machines.len() {
            return bad_request("max_machines must be at least the number of kept devices and at most 64");
        }
    }
    let previous = state.store.get_owner_lock(tenant_id, &owner).await;
    let lock = coord_core::OwnerLock {
        machines,
        allow_one_until: None,
        refused: previous.map(|l| l.refused).unwrap_or_default(),
        max_machines: body.max_machines,
    };
    if let Err(e) = state.store.set_owner_lock(tenant_id, &owner, Some(lock)).await {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response();
    }
    let mut removed = 0;
    for n in owned.iter().filter(|n| !body.node_ids.contains(&n.node_id.as_i64())) {
        if state.store.delete_node(n.node_id).await.is_ok() {
            removed += 1;
        }
    }
    let mut view = owner_lock_view(&state, tenant_id, &owner).await;
    view["removed_nodes"] = serde_json::json!(removed);
    Json(view).into_response()
}

/// POST /api/tenants/{id}/owner-locks/{owner}/allow-one — for a short time,
/// the next new machine of the owner is added to the lock.
pub async fn allow_one_machine(
    State(state): State<Arc<CoordinatorState>>,
    Path((id, owner)): Path<(String, String)>,
    Json(body): Json<AllowOneBody>,
) -> impl IntoResponse {
    let tenant_id = match existing_tenant(&state, &id).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    if body.seconds < 1 || body.seconds > coord_core::lock::MAX_ALLOW_WINDOW_SECS {
        return bad_request("seconds must be 1 to 1800".to_string());
    }
    let Some(mut lock) = state.store.get_owner_lock(tenant_id, &owner).await else {
        return not_found("this owner has no machine lock");
    };
    if lock.is_full() {
        return (StatusCode::CONFLICT, Json(serde_json::json!({ "error": "the lock is at its device limit", "code": "lock_full" }))).into_response();
    }
    lock.allow_one_until = Some(chrono::Utc::now() + chrono::Duration::seconds(body.seconds));
    if let Err(e) = state.store.set_owner_lock(tenant_id, &owner, Some(lock)).await {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response();
    }
    Json(owner_lock_view(&state, tenant_id, &owner).await).into_response()
}

/// DELETE /api/tenants/{id}/owner-locks/{owner}
pub async fn delete_owner_lock(
    State(state): State<Arc<CoordinatorState>>,
    Path((id, owner)): Path<(String, String)>,
) -> impl IntoResponse {
    let tenant_id = match existing_tenant(&state, &id).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    if let Err(e) = state.store.set_owner_lock(tenant_id, &owner, None).await {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response();
    }
    Json(serde_json::json!({ "locked": false })).into_response()
}

#[derive(serde::Deserialize)]
pub struct DeviceAuthApproval {
    pub tenant_id: String,
    pub owner: String,
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
            // Set when this machine is already registered (to refuse moving it between tailnets)
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
    let decision = coord_core::SignInDecision::Approved { tenant_id, owner: body.owner };
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

/// GET /api/tenants/{id}/dns
pub async fn get_tenant_dns(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let tenant_id = match existing_tenant(&state, &id).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    Json(state.store.get_tenant_dns(tenant_id).await).into_response()
}

/// PUT /api/tenants/{id}/dns — replaces the tenant's DNS configuration
/// (ADR-0028). Connected devices get their new names and records at once.
pub async fn set_tenant_dns(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
    Json(body): Json<coord_core::TenantDns>,
) -> impl IntoResponse {
    let tenant_id = match existing_tenant(&state, &id).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    if let Err(e) = body.validate() {
        return bad_request(e.to_string());
    }
    let changed = state.store.get_tenant_dns(tenant_id).await != body;
    if let Err(e) = state.store.set_tenant_dns(tenant_id, body.clone()).await {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response();
    }
    if changed {
        state.notify_tenant_changed(tenant_id);
    }
    Json(body).into_response()
}

const MAX_AUTO_APPROVER_ROUTES: usize = 256;

/// GET /api/tenants/{id}/auto-approvers
pub async fn get_auto_approvers(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let tenant_id = match existing_tenant(&state, &id).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    Json(state.auto_approvers.get_tenant(tenant_id)).into_response()
}

/// PUT /api/tenants/{id}/auto-approvers — replaces the tenant's policy and
/// applies it to already-registered nodes.
pub async fn set_auto_approvers(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
    Json(body): Json<coord_netmap::AutoApprovers>,
) -> impl IntoResponse {
    let tenant_id = match existing_tenant(&state, &id).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    if body.routes.len() > MAX_AUTO_APPROVER_ROUTES {
        return bad_request(format!("at most {MAX_AUTO_APPROVER_ROUTES} auto-approver routes allowed"));
    }
    let mut routes = std::collections::BTreeMap::new();
    for (cidr, tags) in body.routes {
        let Some(norm) = coord_core::routes::normalize_cidr(&cidr) else {
            return bad_request(format!("invalid CIDR: {cidr}"));
        };
        let tags = match validate_auto_approver_tags(tags) {
            Ok(t) => t,
            Err(e) => return bad_request(e),
        };
        routes.entry(norm).or_insert_with(Vec::new).extend(tags);
    }
    for tags in routes.values_mut() {
        tags.sort();
        tags.dedup();
    }
    let exit_node = match validate_auto_approver_tags(body.exit_node) {
        Ok(t) => t,
        Err(e) => return bad_request(e),
    };
    let policy = coord_netmap::AutoApprovers { routes, exit_node };
    if let Err(r) = state.save_config(tenant_id, crate::state::CONFIG_AUTO_APPROVERS, &policy).await {
        return r;
    }
    state.auto_approvers.set_tenant(tenant_id, policy.clone());

    let mut changed = false;
    for node in state.store.list_nodes_for_tenant(tenant_id).await {
        changed |= crate::control::apply_auto_approvers(&state, node.id).await;
    }
    if changed {
        state.notify_tenant_changed(tenant_id);
    }
    Json(policy).into_response()
}

fn validate_auto_approver_tags(tags: Vec<String>) -> Result<Vec<String>, String> {
    if tags.len() > 64 {
        return Err("at most 64 tags per auto-approver entry".into());
    }
    if let Some(bad) = tags.iter().find(|t| !coord_core::routes::is_valid_tag(t)) {
        return Err(format!("invalid tag {bad:?}: must match ^tag:[a-z0-9-]{{1,63}}$"));
    }
    let mut tags = tags;
    tags.sort();
    tags.dedup();
    Ok(tags)
}

#[derive(Serialize)]
pub struct NodeSummaryResponse {
    pub id: i64,
    pub tenant_id: String,
    pub ipv4: String,
    pub stable_id: String,
    pub hostname: String,
    pub online: bool,
    pub owner: Option<String>,
    pub tags: Vec<String>,
    pub ephemeral: bool,
    pub advertised_routes: Vec<String>,
    pub approved_routes: Vec<String>,
}

impl From<coord_core::NodeSummary> for NodeSummaryResponse {
    fn from(n: coord_core::NodeSummary) -> Self {
        Self {
            id: n.id.as_i64(),
            tenant_id: n.tenant_id.to_string(),
            ipv4: n.ipv4.to_string(),
            stable_id: n.stable_id,
            hostname: n.hostname,
            online: n.online,
            owner: n.attrs.owner,
            tags: n.attrs.tags,
            ephemeral: n.attrs.ephemeral,
            advertised_routes: n.attrs.advertised_routes,
            approved_routes: n.attrs.approved_routes,
        }
    }
}

fn node_detail_json(node_id: NodeId, detail: coord_core::NodeDetail) -> NodeSummaryResponse {
    NodeSummaryResponse::from(coord_core::NodeSummary {
        id: node_id,
        tenant_id: detail.tenant_id,
        ipv4: detail.ipv4,
        stable_id: detail.stable_id,
        online: detail.online,
        hostname: detail.info.hostname,
        attrs: detail.attrs,
    })
}

#[derive(Deserialize)]
pub struct SetAclRequest {
    pub tenant_id: String,
    pub policy: coord_acl::AclPolicy,
}

pub async fn set_acl(
    State(state): State<Arc<CoordinatorState>>,
    Json(body): Json<SetAclRequest>,
) -> impl IntoResponse {
    let tenant_id = match body.tenant_id.parse::<uuid::Uuid>() {
        Ok(uuid) => TenantId::new(uuid),
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "invalid tenant_id"})),
            )
                .into_response();
        }
    };

    // Verify tenant exists before storing a policy
    if state.store.get_tenant(tenant_id).await.is_none() {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "tenant not found"})),
        )
            .into_response();
    }

    if let Err(r) = state.save_config(tenant_id, crate::state::CONFIG_ACL, &body.policy).await {
        return r;
    }
    state.acl.set_policy(tenant_id, body.policy);
    state.notify_tenant_changed(tenant_id);

    (
        StatusCode::OK,
        Json(serde_json::json!({"status": "ok", "tenant_id": tenant_id.to_string()})),
    )
        .into_response()
}

#[derive(Deserialize)]
pub struct ListNodesQuery {
    pub tenant_id: Option<String>,
}

pub async fn list_nodes(
    State(state): State<Arc<CoordinatorState>>,
    Query(query): Query<ListNodesQuery>,
) -> impl IntoResponse {
    let nodes = match &query.tenant_id {
        Some(id) => match id.parse::<uuid::Uuid>() {
            Ok(uuid) => state.store.list_nodes_for_tenant(TenantId::new(uuid)).await,
            Err(_) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"error": "invalid tenant_id"})),
                ).into_response();
            }
        },
        None => state.store.list_nodes().await,
    };

    let summaries: Vec<NodeSummaryResponse> = nodes
        .into_iter()
        .map(NodeSummaryResponse::from)
        .collect();

    Json(serde_json::json!({
        "nodes": summaries,
        "count": summaries.len(),
    })).into_response()
}

pub async fn get_tenant_routes(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let tenant_id = match id.parse::<uuid::Uuid>() {
        Ok(uuid) => TenantId::new(uuid),
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "invalid tenant_id"})),
            ).into_response();
        }
    };

    // Use atomic snapshot to prevent posture/nodes interleaving
    let snapshot = match state.store.get_tenant_route_snapshot(tenant_id).await {
        Ok(s) => s,
        Err(_) => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "tenant not found"})),
            ).into_response();
        }
    };

    let child_summaries: Vec<serde_json::Value> = snapshot.children.iter().map(|c| {
        let mut obj = serde_json::json!({
            "id": c.id.to_string(),
            "slug": &c.slug,
            "federation_posture": c.federation_posture.as_str(),
            "visible": c.visible_to_parent(),
        });
        // FIX R15: Document that Selective == Open for now
        if c.federation_posture == coord_core::FederationPosture::Selective {
            obj.as_object_mut().unwrap().insert(
                "posture_note".into(),
                serde_json::Value::String("selective is currently treated as open".into()),
            );
        }
        obj
    }).collect();

    let own_routes: Vec<String> = snapshot.own_nodes.iter()
        .flat_map(|p| p.addresses.clone())
        .collect();

    let aggregated_child_routes: Vec<serde_json::Value> = snapshot.visible_child_nodes.iter()
        .map(|(child_id, slug, nodes)| {
            let routes: Vec<String> = nodes.iter()
                .flat_map(|p| p.addresses.clone())
                .collect();
            serde_json::json!({
                "tenant_id": child_id.to_string(),
                "slug": slug,
                "routes": routes,
                "node_count": nodes.len(),
            })
        })
        .collect();

    Json(serde_json::json!({
        "tenant_id": id,
        "own_routes": own_routes,
        "children": child_summaries,
        "aggregated_child_routes": aggregated_child_routes,
    })).into_response()
}

// ── ACL read/write by tenant path ──

pub async fn get_acl(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let tenant_id = match id.parse::<uuid::Uuid>() {
        Ok(uuid) => TenantId::new(uuid),
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "invalid tenant_id"}))).into_response(),
    };

    match state.acl.get_policy(tenant_id) {
        Some(policy) => Json(serde_json::json!(policy)).into_response(),
        None => {
            // No policy set = allow-all default
            Json(serde_json::json!({
                "default_deny": false,
                "rules": [{"src": "*", "dst": "*", "ports": ["All"]}]
            })).into_response()
        }
    }
}

pub async fn set_acl_for_tenant(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
    Json(body): Json<coord_acl::AclPolicy>,
) -> impl IntoResponse {
    let tenant_id = match id.parse::<uuid::Uuid>() {
        Ok(uuid) => TenantId::new(uuid),
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "invalid tenant_id"}))).into_response(),
    };
    // Verify tenant exists before storing a policy
    if state.store.get_tenant(tenant_id).await.is_none() {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "tenant not found"}))).into_response();
    }
    if let Err(r) = state.save_config(tenant_id, crate::state::CONFIG_ACL, &body).await {
        return r;
    }
    state.acl.set_policy(tenant_id, body);
    state.notify_tenant_changed(tenant_id);
    (StatusCode::OK, Json(serde_json::json!({"status": "ok"}))).into_response()
}

// ── Tenant-scoped node listing ──

pub async fn list_tenant_nodes_handler(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let tenant_id = match id.parse::<uuid::Uuid>() {
        Ok(uuid) => TenantId::new(uuid),
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "invalid tenant_id"}))).into_response(),
    };

    let nodes = state.store.list_nodes_for_tenant(tenant_id).await;
    let summaries: Vec<NodeSummaryResponse> = nodes.into_iter()
        .map(NodeSummaryResponse::from)
        .collect();

    Json(serde_json::json!({"nodes": summaries, "count": summaries.len()})).into_response()
}

// ── Node operations: get, delete, rename ──

#[derive(Deserialize)]
pub struct RenameNodeRequest {
    pub name: String,
}

#[derive(Deserialize)]
pub struct TenantGuardQuery {
    pub tenant_id: Option<String>,
}

/// Returns node info including tenant_id.
/// NOTE: This is an admin endpoint — it intentionally returns data across all
/// tenants. Callers that need tenant-scoped access should use the tenant-scoped
/// node listing endpoint instead.
pub async fn get_node_handler(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let node_id = match id.parse::<i64>() {
        Ok(id) => NodeId::new(id),
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "invalid node_id"}))).into_response(),
    };
    match state.store.get_node_info(node_id).await {
        Some(detail) => Json(node_detail_json(node_id, detail)).into_response(),
        None => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "node not found"}))).into_response(),
    }
}

pub async fn delete_node_handler(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
    Query(query): Query<TenantGuardQuery>,
) -> impl IntoResponse {
    let node_id = match id.parse::<i64>() {
        Ok(id) => NodeId::new(id),
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "invalid node_id"}))).into_response(),
    };

    // If caller specifies tenant_id, verify the node belongs to that tenant before deleting.
    if let Some(ref tid_str) = query.tenant_id {
        let expected_tenant = match tid_str.parse::<uuid::Uuid>() {
            Ok(uuid) => TenantId::new(uuid),
            Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "invalid tenant_id"}))).into_response(),
        };
        let actual_tenant = state.store.get_node_tenant(node_id).await;
        if actual_tenant != Some(expected_tenant) {
            return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "node does not belong to specified tenant"}))).into_response();
        }
    }

    match state.store.delete_node(node_id).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({"status": "deleted"}))).into_response(),
        Err(coord_core::CoordError::Protocol(ref msg)) if msg.contains("not found") => {
            (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "node not found"}))).into_response()
        }
        Err(e) => internal_error(e).into_response(),
    }
}

// ── Per-tenant DERP configuration ──

const CUSTOM_DERP_REGION_MIN: i32 = 900;
const CUSTOM_DERP_REGION_MAX: i32 = 999;

#[derive(Deserialize)]
pub struct SetTenantDerpRequest {
    #[serde(default)]
    pub regions: std::collections::HashMap<String, coord_proto::map::DerpRegion>,
    pub include_default: bool,
}

fn parse_tenant_id(id: &str) -> Option<TenantId> {
    id.parse::<uuid::Uuid>().ok().map(TenantId::new)
}

fn bad_request(msg: impl Into<String>) -> axum::response::Response {
    (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": msg.into()}))).into_response()
}

pub async fn get_tenant_derp(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let Some(tenant_id) = parse_tenant_id(&id) else {
        return bad_request("invalid tenant_id");
    };
    if state.store.get_tenant(tenant_id).await.is_none() {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "tenant not found"}))).into_response();
    }
    let cfg = state.derp.get_tenant(tenant_id);
    Json(serde_json::json!({
        "regions": cfg.as_ref().map(|c| c.custom_regions.clone()).unwrap_or_default(),
        "include_default": cfg.as_ref().map(|c| c.include_default).unwrap_or(true),
        "effective": state.derp.map_for(tenant_id),
    })).into_response()
}

pub async fn set_tenant_derp(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
    Json(body): Json<SetTenantDerpRequest>,
) -> impl IntoResponse {
    let Some(tenant_id) = parse_tenant_id(&id) else {
        return bad_request("invalid tenant_id");
    };
    if state.store.get_tenant(tenant_id).await.is_none() {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "tenant not found"}))).into_response();
    }

    let mut custom_regions = std::collections::HashMap::new();
    for (key, mut region) in body.regions {
        if key.parse::<i32>().ok() != Some(region.region_id) {
            return bad_request(format!("region key {key} does not match RegionID {}", region.region_id));
        }
        if !(CUSTOM_DERP_REGION_MIN..=CUSTOM_DERP_REGION_MAX).contains(&region.region_id) {
            return bad_request(format!("custom region IDs must be {CUSTOM_DERP_REGION_MIN}-{CUSTOM_DERP_REGION_MAX}"));
        }
        if region.nodes.is_empty() {
            return bad_request(format!("region {} has no nodes", region.region_id));
        }
        for node in &mut region.nodes {
            if !is_valid_hostname(&node.host_name) {
                return bad_request(format!("invalid DERP hostname: {}", node.host_name));
            }
            node.region_id = region.region_id;
            // Only meaningful in test harnesses; never let a tenant disable TLS verification.
            node.insecure_for_tests = None;
        }
        custom_regions.insert(region.region_id, region);
    }

    if custom_regions.is_empty() && !body.include_default {
        return bad_request("DERP config must include the default regions or at least one custom region");
    }

    let region_count = custom_regions.len();
    let derp = coord_netmap::TenantDerp { custom_regions, include_default: body.include_default };
    if let Err(r) = state.save_config(tenant_id, crate::state::CONFIG_DERP, &derp).await {
        return r;
    }
    state.derp.set_tenant(tenant_id, derp);
    state.notify_tenant_changed(tenant_id);
    tracing::info!(tenant = %tenant_id, custom_regions = region_count, "tenant DERP config updated");

    Json(serde_json::json!({"status": "updated", "effective": state.derp.map_for(tenant_id)})).into_response()
}

pub async fn rename_node_handler(
    State(state): State<Arc<CoordinatorState>>,
    Path(id): Path<String>,
    Query(query): Query<TenantGuardQuery>,
    Json(body): Json<RenameNodeRequest>,
) -> impl IntoResponse {
    let node_id = match id.parse::<i64>() {
        Ok(id) => NodeId::new(id),
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "invalid node_id"}))).into_response(),
    };

    if !is_valid_hostname(&body.name) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "invalid hostname: must match ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$"})),
        ).into_response();
    }

    // If caller specifies tenant_id, verify the node belongs to that tenant before renaming.
    if let Some(ref tid_str) = query.tenant_id {
        let expected_tenant = match tid_str.parse::<uuid::Uuid>() {
            Ok(uuid) => TenantId::new(uuid),
            Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "invalid tenant_id"}))).into_response(),
        };
        let actual_tenant = state.store.get_node_tenant(node_id).await;
        if actual_tenant != Some(expected_tenant) {
            return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "node does not belong to specified tenant"}))).into_response();
        }
    }

    match state.store.rename_node(node_id, body.name).await {
        Ok(()) => {
            match state.store.get_node_info(node_id).await {
                Some(detail) => Json(node_detail_json(node_id, detail)).into_response(),
                None => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "node not found"}))).into_response(),
            }
        }
        Err(coord_core::CoordError::Protocol(ref msg)) if msg.contains("not found") => {
            (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "node not found"}))).into_response()
        }
        Err(e) => internal_error(e).into_response(),
    }
}

