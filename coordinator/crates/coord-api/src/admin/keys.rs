use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use coord_core::TenantId;
use crate::state::CoordinatorState;
use super::{bad_request, existing_tenant, internal_error, not_found, required_owner, validate_owner, OwnerQuery};


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

fn validate_tags(tags: Vec<String>) -> Result<Vec<String>, String> {
    if tags.len() > coord_core::routes::MAX_TAGS {
        return Err(format!("at most {} tags allowed", coord_core::routes::MAX_TAGS));
    }
    if let Some(bad) = tags.iter().find(|t| !coord_core::routes::is_valid_tag(t)) {
        return Err(format!("invalid tag {bad:?}: must match ^tag:[a-z0-9-]{{1,63}}$"));
    }
    // The gateway tag is reserved: it claims the gateway name and hides the node from device lists.
    if tags.iter().any(|t| t == coord_core::GATEWAY_TAG) {
        return Err(format!("{} is reserved for the coordinator", coord_core::GATEWAY_TAG));
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
    if let Some(owner) = &body.owner
        && let Err(e) = validate_owner(owner) {
            return bad_request(e);
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
        Err(msg) => return bad_request(msg),
    };
    match state.store.revoke_preauth_keys_by_owner(tenant_id, &owner).await {
        Ok(n) => Json(serde_json::json!({"revoked": n})).into_response(),
        Err(e) => internal_error(e).into_response(),
    }
}
