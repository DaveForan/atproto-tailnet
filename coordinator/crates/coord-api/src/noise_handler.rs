use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, Response, StatusCode};
use axum::response::IntoResponse;
use bytes::Bytes;
use http_body_util::Full;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tracing::{error, info, warn};

use coord_noise::NoiseResponder;

use crate::control;
use crate::state::CoordinatorState;

const UPGRADE_HEADER_VALUE: &str = "tailscale-control-protocol";
const HANDSHAKE_HEADER_NAME: &str = "X-Tailscale-Handshake";

pub async fn ts2021_handler(
    State(state): State<Arc<CoordinatorState>>,
    req: Request<Body>,
) -> impl IntoResponse {
    let upgrade_header = req
        .headers()
        .get("upgrade")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if upgrade_header != UPGRADE_HEADER_VALUE {
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .body(Body::from("expected Upgrade: tailscale-control-protocol"))
            .unwrap();
    }

    let init_b64 = match req.headers().get(HANDSHAKE_HEADER_NAME) {
        Some(v) => match v.to_str() {
            Ok(s) => s.to_string(),
            Err(_) => {
                return Response::builder()
                    .status(StatusCode::BAD_REQUEST)
                    .body(Body::from("invalid handshake header encoding"))
                    .unwrap();
            }
        },
        None => {
            return Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .body(Body::from("missing X-Tailscale-Handshake header"))
                .unwrap();
        }
    };

    let initiation = match base64::decode(&init_b64) {
        Ok(bytes) => bytes,
        Err(e) => {
            warn!(error = %e, "invalid base64 in handshake header");
            return Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .body(Body::from("invalid base64 in handshake header"))
                .unwrap();
        }
    };

    let responder = NoiseResponder::new(state.control_key.clone());
    let (split_keys, response_msg, machine_key, version) = match responder.accept_initiation(&initiation) {
        Ok(result) => result,
        Err(e) => {
            warn!(error = %e, "noise handshake failed");
            return Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .body(Body::from("noise handshake failed"))
                .unwrap();
        }
    };

    info!(
        machine_key = hex::encode(machine_key),
        protocol_version = version,
        "noise handshake complete"
    );

    let on_upgrade = hyper::upgrade::on(req);

    tokio::spawn(async move {
        match on_upgrade.await {
            Ok(upgraded) => {
                if let Err(e) = run_noise_session(state, upgraded, split_keys, response_msg, machine_key).await {
                    warn!(error = %e, "noise session ended with error");
                }
            }
            Err(e) => error!(error = %e, "upgrade failed"),
        }
    });

    Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header("Upgrade", UPGRADE_HEADER_VALUE)
        .header("Connection", "Upgrade")
        .body(Body::empty())
        .unwrap()
}

async fn run_noise_session(
    state: Arc<CoordinatorState>,
    upgraded: hyper::upgrade::Upgraded,
    split_keys: coord_noise::handshake::SplitKeys,
    response_msg: Vec<u8>,
    machine_key: [u8; 32],
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut io = hyper_util::rt::TokioIo::new(upgraded);

    io.write_all(&response_msg).await?;
    io.flush().await?;

    let transport = coord_noise::NoiseTransport::from_responder_keys(
        split_keys.initiator_key,
        split_keys.responder_key,
    );
    let cleartext_stream = coord_noise::spawn_noise_bridge(io, transport);

    let h2_io = hyper_util::rt::TokioIo::new(cleartext_stream);

    let state_for_disconnect = state.clone();
    let state_for_service = state;
    let service = hyper::service::service_fn(move |req: Request<hyper::body::Incoming>| {
        let state = state_for_service.clone();
        let mk = machine_key;
        async move {
            handle_control_request(state, mk, req).await
        }
    });

    let result = hyper::server::conn::http2::Builder::new(hyper_util::rt::TokioExecutor::new())
        .serve_connection(h2_io, service)
        .await;

    if let Some(node_id) = state_for_disconnect.store.get_node_by_machine_key(&machine_key) {
        info!(node = %node_id, "noise session ended, marking node offline");
        state_for_disconnect.store.set_node_online(node_id, false);
    }

    result?;
    Ok(())
}

type BoxBody = http_body_util::combinators::BoxBody<Bytes, std::io::Error>;

fn full_body(bytes: Bytes) -> BoxBody {
    use http_body_util::BodyExt;
    Full::new(bytes).map_err(|_| unreachable!()).boxed()
}

fn json_error(status: StatusCode, msg: &str) -> Response<BoxBody> {
    Response::builder()
        .status(status)
        .body(full_body(Bytes::from(
            serde_json::json!({"error": msg}).to_string(),
        )))
        .unwrap()
}

async fn handle_control_request(
    state: Arc<CoordinatorState>,
    machine_key: [u8; 32],
    req: Request<hyper::body::Incoming>,
) -> Result<Response<BoxBody>, std::io::Error> {
    let path = req.uri().path().to_string();
    let body_bytes = match http_body_util::BodyExt::collect(req.into_body()).await {
        Ok(collected) => collected.to_bytes(),
        Err(e) => {
            warn!(error = %e, "failed to read request body");
            return Ok(json_error(StatusCode::BAD_REQUEST, "failed to read body"));
        }
    };

    let body_str = String::from_utf8_lossy(&body_bytes);

    match path.as_str() {
        "/machine/register" => Ok(handle_register_request(state, machine_key, &body_str).await),
        "/machine/map" => Ok(handle_map_request(state, machine_key, &body_str).await),
        _ => Ok(json_error(StatusCode::NOT_FOUND, "not found")),
    }
}

async fn handle_register_request(
    state: Arc<CoordinatorState>,
    machine_key: [u8; 32],
    body: &str,
) -> Response<BoxBody> {
    match control::handle_register(&state, &machine_key, body).await {
        Ok(response_body) => Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", "application/json")
            .body(full_body(Bytes::from(response_body)))
            .unwrap(),
        Err(e) => {
            warn!(error = %e, "register request failed");
            json_error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string())
        }
    }
}

fn frame_map_response(json_bytes: &[u8]) -> Vec<u8> {
    let compressed = zstd::bulk::compress(json_bytes, 3).expect("zstd compress");
    let len = compressed.len() as u32;
    let mut out = Vec::with_capacity(4 + compressed.len());
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(&compressed);
    out
}

async fn handle_map_request(
    state: Arc<CoordinatorState>,
    machine_key: [u8; 32],
    body: &str,
) -> Response<BoxBody> {
    let req: coord_proto::map::MapRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(e) => return json_error(StatusCode::BAD_REQUEST, &format!("invalid map request: {e}")),
    };

    let is_streaming = req.stream.unwrap_or(false);

    if !is_streaming {
        match control::handle_map(&state, &machine_key, body).await {
            Ok(response_json) => {
                let framed = frame_map_response(response_json.as_bytes());
                Response::builder()
                    .status(StatusCode::OK)
                    .body(full_body(Bytes::from(framed)))
                    .unwrap()
            }
            Err(e) => {
                warn!(error = %e, "map request failed");
                json_error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string())
            }
        }
    } else {
        handle_streaming_map(state, machine_key, body.to_string()).await
    }
}

async fn handle_streaming_map(
    state: Arc<CoordinatorState>,
    machine_key: [u8; 32],
    body: String,
) -> Response<BoxBody> {
    // Subscribe BEFORE computing snapshot so no events are lost between
    // snapshot and subscribe. Duplicate events are harmless (client merges
    // PeersChanged idempotently).
    let mut peer_rx = state.store.subscribe();

    let initial = match control::handle_map(&state, &machine_key, &body).await {
        Ok(json) => json,
        Err(e) => {
            warn!(error = %e, "streaming map initial response failed");
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
        }
    };

    let node_id = match state.store.get_node_by_machine_key(&machine_key) {
        Some(id) => id,
        None => return json_error(StatusCode::NOT_FOUND, "node not registered"),
    };

    let tenant_id = match state.store.get_node_tenant(node_id) {
        Some(tid) => tid,
        None => return json_error(StatusCode::NOT_FOUND, "node has no tenant"),
    };

    let (tx, rx) = tokio::sync::mpsc::channel::<Result<hyper::body::Frame<Bytes>, std::io::Error>>(32);

    let initial_frame = frame_map_response(initial.as_bytes());
    let _ = tx.send(Ok(hyper::body::Frame::data(Bytes::from(initial_frame)))).await;
    let state_clone = state.clone();

    tokio::spawn(async move {
        use std::time::Duration;
        let keepalive_interval = Duration::from_secs(60);

        loop {
            tokio::select! {
                event = peer_rx.recv() => {
                    let event = match event {
                        Ok(e) => e,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                            tracing::warn!(skipped = n, "map stream lagged, sending full update");
                            if let Ok(json) = control::handle_map(&state_clone, &machine_key, &body).await {
                                let framed = frame_map_response(json.as_bytes());
                                if tx.send(Ok(hyper::body::Frame::data(Bytes::from(framed)))).await.is_err() {
                                    break;
                                }
                            }
                            continue;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    };

                    let event_tenant = match &event {
                        coord_store::PeerEvent::NodeJoined { tenant_id: t, .. } => *t,
                        coord_store::PeerEvent::NodeUpdated { tenant_id: t, .. } => *t,
                        coord_store::PeerEvent::NodeOffline { tenant_id: t, .. } => *t,
                    };

                    if event_tenant != tenant_id {
                        continue;
                    }

                    let event_node_id = match &event {
                        coord_store::PeerEvent::NodeJoined { node_id: n, .. } => *n,
                        coord_store::PeerEvent::NodeUpdated { node_id: n, .. } => *n,
                        coord_store::PeerEvent::NodeOffline { node_id: n, .. } => *n,
                    };

                    // Don't notify a node about its own changes
                    if event_node_id == node_id {
                        continue;
                    }

                    let delta = control::build_delta_response(
                        &state_clone,
                        &machine_key,
                        &event,
                    );

                    if let Some(json) = delta {
                        let framed = frame_map_response(json.as_bytes());
                        if tx.send(Ok(hyper::body::Frame::data(Bytes::from(framed)))).await.is_err() {
                            break;
                        }
                    }
                }
                _ = tokio::time::sleep(keepalive_interval) => {
                    let keepalive = serde_json::json!({"KeepAlive": true});
                    let framed = frame_map_response(keepalive.to_string().as_bytes());
                    if tx.send(Ok(hyper::body::Frame::data(Bytes::from(framed)))).await.is_err() {
                        break;
                    }
                }
            }
        }

        tracing::debug!(node = %node_id, "streaming map session ended");
    });

    let stream = tokio_stream::wrappers::ReceiverStream::new(rx);
    let body = http_body_util::StreamBody::new(stream);
    use http_body_util::BodyExt;
    Response::builder()
        .status(StatusCode::OK)
        .body(body.boxed())
        .unwrap()
}

mod base64 {
    pub fn decode(input: &str) -> Result<Vec<u8>, String> {
        let input = input.trim_end_matches('=');
        let mut out = Vec::with_capacity(input.len() * 3 / 4);
        let mut buf: u32 = 0;
        let mut bits: u32 = 0;

        for &b in input.as_bytes() {
            let val = match b {
                b'A'..=b'Z' => b - b'A',
                b'a'..=b'z' => b - b'a' + 26,
                b'0'..=b'9' => b - b'0' + 52,
                b'+' | b'-' => 62,
                b'/' | b'_' => 63,
                b'\r' | b'\n' | b' ' | b'\t' => continue,
                _ => return Err(format!("invalid base64 byte: 0x{:02x}", b)),
            } as u32;
            buf = (buf << 6) | val;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((buf >> bits) as u8);
                buf &= (1 << bits) - 1;
            }
        }
        Ok(out)
    }
}
