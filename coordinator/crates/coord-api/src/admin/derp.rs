use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use std::sync::Arc;

use crate::state::CoordinatorState;
use coord_core::is_valid_hostname;
use super::{bad_request, parse_tenant_id};

// ── Per-tenant DERP configuration ──

const CUSTOM_DERP_REGION_MIN: i32 = 900;
const CUSTOM_DERP_REGION_MAX: i32 = 999;

#[derive(Deserialize)]
pub struct SetTenantDerpRequest {
    #[serde(default)]
    pub regions: std::collections::HashMap<String, coord_proto::map::DerpRegion>,
    pub include_default: bool,
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
    let cfg = state.caches.derp.get_tenant(tenant_id);
    Json(serde_json::json!({
        "regions": cfg.as_ref().map(|c| c.custom_regions.clone()).unwrap_or_default(),
        "include_default": cfg.as_ref().map(|c| c.include_default).unwrap_or(true),
        "effective": state.caches.derp.map_for(tenant_id),
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
    state.caches.derp.set_tenant(tenant_id, derp);
    state.notify_tenant_changed(tenant_id);
    tracing::info!(tenant = %tenant_id, custom_regions = region_count, "tenant DERP config updated");

    Json(serde_json::json!({"status": "updated", "effective": state.caches.derp.map_for(tenant_id)})).into_response()
}
