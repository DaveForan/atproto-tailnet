use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use std::sync::Arc;

use crate::state::CoordinatorState;

/// Matches tailcfg.OverTLSPublicKeyResponse
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct KeyResponse {
    legacy_public_key: String,
    public_key: String,
}

pub async fn key_handler(
    State(state): State<Arc<CoordinatorState>>,
) -> impl IntoResponse {
    let mkey = format!("mkey:{}", hex::encode(state.control_key.public));

    let resp = KeyResponse {
        legacy_public_key: mkey.clone(),
        public_key: mkey,
    };

    (
        StatusCode::OK,
        [("Content-Type", "application/json")],
        serde_json::to_string(&resp).unwrap(),
    )
}
