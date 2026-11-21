use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use std::sync::Arc;

use coord_core::TenantId;
use crate::state::CoordinatorState;
use super::{bad_request, existing_tenant, not_found};

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

fn lock_store_error(e: coord_core::CoordError) -> axum::response::Response {
    match e {
        coord_core::CoordError::TenantNotFound(_) => not_found("tenant not found"),
        e => {
            tracing::error!(error = %e, "machine lock store error");
            (StatusCode::SERVICE_UNAVAILABLE, Json(serde_json::json!({ "error": "the machine lock could not be read or written; try again" }))).into_response()
        }
    }
}

async fn owner_lock_view(state: &CoordinatorState, tenant_id: TenantId, owner: &str) -> Result<serde_json::Value, axum::response::Response> {
    let read = state.store.get_owner_lock(tenant_id, owner).await.map_err(lock_store_error)?;
    Ok(owner_lock_json(state, tenant_id, owner, &read).await)
}

async fn owner_lock_json(state: &CoordinatorState, tenant_id: TenantId, owner: &str, read: &coord_core::LockRead) -> serde_json::Value {
    let lock = read.lock();
    let allowed: Vec<i64> = match lock {
        Some(l) => state
            .store
            .list_tenant_nodes(tenant_id)
            .await
            .iter()
            .filter(|n| n.owner.as_deref() == Some(owner) && l.allows(&hex::encode(&n.machine_key)))
            .map(|n| n.node_id.as_i64())
            .collect(),
        None => vec![],
    };
    serde_json::json!({
        "locked": read.is_locked(),
        // A stored lock that cannot be read: it refuses every machine until it is set again or removed.
        "malformed": *read == coord_core::LockRead::Malformed,
        "node_ids": allowed,
        "allow_one_until": lock.and_then(|l| l.allow_one_until),
        "max_machines": lock.and_then(|l| l.max_machines),
        "refused": lock.map(|l| l.refused.clone()).unwrap_or_default(),
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
    match owner_lock_view(&state, tenant_id, &owner).await {
        Ok(v) => Json(v).into_response(),
        Err(r) => r,
    }
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
    if let Some(max) = body.max_machines
        && (max < 1 || max as usize > coord_core::lock::MAX_LOCK_MACHINES || (max as usize) < machines.len()) {
            return bad_request("max_machines must be at least the number of kept devices and at most 64");
        }
    let max_machines = body.max_machines;
    // One atomic step: the refused history kept is the one stored now, not a
    // copy read earlier that a concurrent registration may have extended.
    let written = state
        .store
        .update_owner_lock(tenant_id, &owner, move |read| {
            let refused = read.lock().map(|l| l.refused.clone()).unwrap_or_default();
            let lock = coord_core::OwnerLock { machines, allow_one_until: None, refused, max_machines };
            (coord_core::LockWrite::Set(lock.clone()), lock)
        })
        .await;
    let lock = match written {
        Ok(l) => l,
        Err(e) => return lock_store_error(e),
    };
    let mut removed = 0;
    // Remove every node of the owner whose machine is not in the lock — listed
    // again now, so a machine that registered meanwhile is not left behind.
    for n in state.store.list_tenant_nodes(tenant_id).await.iter().filter(|n| {
        n.owner.as_deref() == Some(owner.as_str()) && !lock.allows(&hex::encode(&n.machine_key))
    }) {
        match state.store.delete_node(n.node_id).await {
            Ok(_) => removed += 1,
            Err(e) => tracing::error!(error = %e, node_id = n.node_id.as_i64(), "could not remove a device outside the machine lock"),
        }
    }
    let mut view = owner_lock_json(&state, tenant_id, &owner, &coord_core::LockRead::Locked(lock)).await;
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
    enum Opened {
        Yes(coord_core::OwnerLock),
        NoLock,
        Malformed,
        Full,
    }
    let until = chrono::Utc::now() + chrono::Duration::seconds(body.seconds);
    let result = state
        .store
        .update_owner_lock(tenant_id, &owner, move |read| match read {
            coord_core::LockRead::Unlocked => (coord_core::LockWrite::Keep, Opened::NoLock),
            coord_core::LockRead::Malformed => (coord_core::LockWrite::Keep, Opened::Malformed),
            coord_core::LockRead::Locked(lock) if lock.is_full() => (coord_core::LockWrite::Keep, Opened::Full),
            coord_core::LockRead::Locked(mut lock) => {
                lock.allow_one_until = Some(until);
                (coord_core::LockWrite::Set(lock.clone()), Opened::Yes(lock))
            }
        })
        .await;
    match result {
        Ok(Opened::Yes(lock)) => Json(owner_lock_json(&state, tenant_id, &owner, &coord_core::LockRead::Locked(lock)).await).into_response(),
        Ok(Opened::NoLock) => not_found("this owner has no machine lock"),
        Ok(Opened::Malformed) => (StatusCode::CONFLICT, Json(serde_json::json!({ "error": "the stored machine lock cannot be read; set it again", "code": "lock_malformed" }))).into_response(),
        Ok(Opened::Full) => (StatusCode::CONFLICT, Json(serde_json::json!({ "error": "the lock is at its device limit", "code": "lock_full" }))).into_response(),
        Err(e) => lock_store_error(e),
    }
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
        return lock_store_error(e);
    }
    Json(serde_json::json!({ "locked": false })).into_response()
}
