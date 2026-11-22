use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, Response, StatusCode};
use axum::response::IntoResponse;
use bytes::Bytes;
use http_body_util::Full;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tokio::io::AsyncWriteExt;
use tracing::{error, info, warn};

use coord_noise::NoiseResponder;

use crate::control;
use crate::state::CoordinatorState;

const UPGRADE_HEADER_VALUE: &str = "tailscale-control-protocol";
const HANDSHAKE_HEADER_NAME: &str = "X-Tailscale-Handshake";

// These limits apply before authentication: any machine key completes the Noise handshake.
/// Max concurrent HTTP/2 streams per Noise connection. tailscaled needs one map stream plus a few short requests.
/// hyper's default (~200) lets one connection buffer 200 bodies at once.
pub const MAX_CONCURRENT_STREAMS: u32 = 8;
/// Max request body for /machine/register and /machine/map. Real requests are a few KiB.
pub const MAX_CONTROL_BODY: usize = 256 * 1024;
/// Max HTTP/2 header list size (hyper defaults to 16 MiB).
const MAX_HEADER_LIST_SIZE: u32 = 16 * 1024;
/// A request body must arrive within this window (slowloris bound).
const BODY_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

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

    // Behind Caddy: X-Forwarded-For, believed only from a trusted proxy.
    let peer = req
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .map(|c| c.0.ip());
    let client_ip = state.trusted_proxies.client_ip(peer, req.headers());

    // Both caps are taken before any crypto work and held for the lifetime of the Noise session.
    let ip_permit = match client_ip {
        Some(ip) => match state.noise_per_ip.try_acquire(ip) {
            Some(p) => Some(p),
            None => {
                if let Some(suppressed) = state.noise_refused_log.check(client_ip) {
                    warn!(client_ip = %ip, suppressed, "per-address noise connection limit reached; refusing ts2021 upgrade");
                }
                return Response::builder()
                    .status(StatusCode::TOO_MANY_REQUESTS)
                    .header("Retry-After", "30")
                    .body(Body::from("too many control connections from this address"))
                    .unwrap();
            }
        },
        None => None,
    };
    let permit = match state.noise_conns.clone().try_acquire_owned() {
        Ok(p) => p,
        Err(_) => {
            warn!(
                limit = state.max_noise_conns,
                "noise connection limit reached; refusing ts2021 upgrade"
            );
            return Response::builder()
                .status(StatusCode::SERVICE_UNAVAILABLE)
                .header("Retry-After", "30")
                .body(Body::from("too many control connections"))
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
        machine_key_prefix = &hex::encode(machine_key)[..16],
        protocol_version = version,
        "noise handshake complete"
    );

    let on_upgrade = hyper::upgrade::on(req);

    tokio::spawn(async move {
        let _permits = (permit, ip_permit);
        match on_upgrade.await {
            Ok(upgraded) => {
                if let Err(e) = run_noise_session(state, upgraded, split_keys, response_msg, machine_key, client_ip).await {
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
    client_ip: Option<std::net::IpAddr>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut io = hyper_util::rt::TokioIo::new(upgraded);

    io.write_all(&response_msg).await?;
    io.flush().await?;

    let transport = coord_noise::NoiseTransport::from_responder_keys(
        split_keys.initiator_key,
        split_keys.responder_key,
    );
    let cleartext_stream = coord_noise::spawn_noise_bridge(io, transport);

    serve_control_h2(state, cleartext_stream, machine_key, client_ip).await
}

/// Serves control HTTP/2 over a Noise-decrypted stream, then marks the node offline if this session registered it.
pub(crate) async fn serve_control_h2<IO>(
    state: Arc<CoordinatorState>,
    io: IO,
    machine_key: [u8; 32],
    client_ip: Option<std::net::IpAddr>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
where
    IO: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let h2_io = hyper_util::rt::TokioIo::new(io);

    // /machine/register sets the session generation. The disconnect handler reads it.
    let session_gen = Arc::new(AtomicU64::new(0));
    // Any machine key completes the handshake. Before the deadline, a session must register,
    // start a sign-in, or poll the map as a known machine.
    let authed = Arc::new(AtomicBool::new(false));
    let deadline = state.noise_auth_deadline;

    let state_for_disconnect = state.clone();
    let state_for_service = state;
    let session_gen_for_service = session_gen.clone();
    let authed_for_service = authed.clone();
    let service = hyper::service::service_fn(move |req: Request<hyper::body::Incoming>| {
        let state = state_for_service.clone();
        let mk = machine_key;
        let sg = session_gen_for_service.clone();
        let authed = authed_for_service.clone();
        async move {
            handle_control_request(state, mk, client_ip, sg, authed, req).await
        }
    });

    // keep_alive_* need a timer. Without one, hyper panics on the first connection.
    let conn = hyper::server::conn::http2::Builder::new(hyper_util::rt::TokioExecutor::new())
        .timer(hyper_util::rt::TokioTimer::new())
        .keep_alive_interval(Some(std::time::Duration::from_secs(30)))
        .keep_alive_timeout(std::time::Duration::from_secs(90))
        .max_concurrent_streams(MAX_CONCURRENT_STREAMS)
        .max_header_list_size(MAX_HEADER_LIST_SIZE)
        .serve_connection(h2_io, service);
    tokio::pin!(conn);
    let result = tokio::select! {
        r = &mut conn => r,
        () = unauthenticated_after(deadline, &authed) => {
            info!(
                machine_key_prefix = &hex::encode(machine_key)[..16],
                client_ip = ?client_ip,
                "closing noise session that did not authenticate in time"
            );
            // Dropping the connection closes the stream.
            Ok(())
        }
    };

    let sess_gen = session_gen.load(Ordering::Acquire);
    if sess_gen > 0
        && let Some(node_id) = state_for_disconnect.store.get_node_by_machine_key(&machine_key).await {
            info!(node = %node_id, generation = sess_gen, "noise session ended, marking node offline");
            if let Err(e) = state_for_disconnect.store.set_node_offline_if_current(node_id, sess_gen).await {
                warn!(error = %e, node = %node_id, "set_node_offline_if_current failed");
            }
        }

    result?;
    Ok(())
}

/// Completes after `deadline` unless the session authenticated by then.
async fn unauthenticated_after(deadline: std::time::Duration, authed: &AtomicBool) {
    tokio::time::sleep(deadline).await;
    if authed.load(Ordering::Acquire) {
        std::future::pending::<()>().await;
    }
}

pub(crate) type BoxBody = http_body_util::combinators::BoxBody<Bytes, std::io::Error>;

fn full_body(bytes: Bytes) -> BoxBody {
    use http_body_util::BodyExt;
    Full::new(bytes).map_err(|_| unreachable!()).boxed()
}

pub(crate) fn json_error(status: StatusCode, msg: &str) -> Response<BoxBody> {
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
    client_ip: Option<std::net::IpAddr>,
    session_gen: Arc<AtomicU64>,
    authed: Arc<AtomicBool>,
    req: Request<hyper::body::Incoming>,
) -> Result<Response<BoxBody>, std::io::Error> {
    let path = req.uri().path().to_string();
    if path != "/machine/register" && path != "/machine/map" {
        return Ok(json_error(StatusCode::NOT_FOUND, "not found"));
    }
    let body_bytes = {
        let read = async {
            // Bound total buffered bodies across all connections.
            let _permit = state.noise_body_reads.acquire().await.ok()?;
            http_body_util::BodyExt::collect(
                http_body_util::Limited::new(req.into_body(), MAX_CONTROL_BODY),
            )
            .await
            .ok()
            .map(|c| c.to_bytes())
        };
        match tokio::time::timeout(BODY_READ_TIMEOUT, read).await {
            Ok(Some(bytes)) => bytes,
            Ok(None) | Err(_) => {
                warn!(path = %path, "control request body too large, unreadable or too slow");
                return Ok(json_error(StatusCode::BAD_REQUEST, "request body too large or unreadable"));
            }
        }
    };

    let body_str = match String::from_utf8(body_bytes.to_vec()) {
        Ok(s) => s,
        Err(_) => return Ok(json_error(StatusCode::BAD_REQUEST, "invalid UTF-8 in request body")),
    };

    match path.as_str() {
        "/machine/register" => Ok(handle_register_request(state, machine_key, client_ip, session_gen, &authed, &body_str).await),
        "/machine/map" => {
            if !authed.load(Ordering::Acquire) && state.store.get_node_by_machine_key(&machine_key).await.is_some() {
                authed.store(true, Ordering::Release);
            }
            Ok(handle_map_request(state, machine_key, &session_gen, &body_str).await)
        }
        _ => Ok(json_error(StatusCode::NOT_FOUND, "not found")),
    }
}

async fn handle_register_request(
    state: Arc<CoordinatorState>,
    machine_key: [u8; 32],
    client_ip: Option<std::net::IpAddr>,
    session_gen: Arc<AtomicU64>,
    authed: &AtomicBool,
    body: &str,
) -> Response<BoxBody> {
    match control::handle_register(&state, &machine_key, body, client_ip).await {
        Ok((response_body, generation)) => {
            if let Some(g) = generation {
                session_gen.store(g, Ordering::Release);
            }
            if generation.is_some() || grants_session(&response_body) {
                authed.store(true, Ordering::Release);
            }
            Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", "application/json")
                .body(full_body(Bytes::from(response_body)))
                .unwrap()
        }
        Err(e) => {
            warn!(error = %e, "register request failed");
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
        }
    }
}

/// True for a register response that authorizes the machine or starts an interactive sign-in.
fn grants_session(response_body: &str) -> bool {
    serde_json::from_str::<coord_proto::register::RegisterResponse>(response_body)
        .is_ok_and(|r| r.machine_authorized || !r.auth_url.is_empty())
}

pub(crate) fn frame_map_response(json_bytes: &[u8]) -> Result<Vec<u8>, std::io::Error> {
    let compressed = zstd::bulk::compress(json_bytes, 3)?;
    let len: u32 = compressed.len().try_into().map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "compressed frame exceeds u32::MAX")
    })?;
    let mut out = Vec::with_capacity(4 + compressed.len());
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(&compressed);
    Ok(out)
}

pub(crate) async fn handle_map_request(
    state: Arc<CoordinatorState>,
    machine_key: [u8; 32],
    session_gen: &AtomicU64,
    body: &str,
) -> Response<BoxBody> {
    let req: coord_proto::map::MapRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(e) => return json_error(StatusCode::BAD_REQUEST, &format!("invalid map request: {e}")),
    };

    // Unknown machines get 401 and suspended tenants get 403, not 500.
    // tailscaled treats both as a failed poll and backs off.
    let Some(node_id) = state.store.get_node_by_machine_key(&machine_key).await else {
        return json_error(StatusCode::UNAUTHORIZED, "node not registered");
    };
    if let Some(tenant_id) = state.store.get_node_tenant(node_id).await
        && state.store.is_tenant_suspended(tenant_id).await {
            return json_error(StatusCode::FORBIDDEN, control::TENANT_SUSPENDED_MSG);
        }

    let is_streaming = req.stream.unwrap_or(false);

    // A reconnecting device opens a map stream without registering again.
    // The stream is its session: mark it online and own the generation, so this
    // connection's end marks it offline only while no newer session exists.
    if is_streaming {
        match state.store.begin_node_session(node_id).await {
            Ok(generation) => session_gen.store(generation, Ordering::Release),
            Err(e) => warn!(error = %e, node = %node_id, "begin_node_session failed"),
        }
    }

    if !is_streaming {
        match control::handle_map(&state, &machine_key, body).await {
            Ok(response_json) => {
                match frame_map_response(response_json.as_bytes()) {
                    Ok(framed) => Response::builder()
                        .status(StatusCode::OK)
                        .body(full_body(Bytes::from(framed)))
                        .unwrap(),
                    Err(e) => {
                        warn!(error = %e, "zstd compression failed");
                        json_error(StatusCode::INTERNAL_SERVER_ERROR, "compression error")
                    }
                }
            }
            Err(e) => {
                warn!(error = %e, "map request failed");
                json_error(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
            }
        }
    } else {
        crate::map_stream::handle_streaming_map(state, machine_key, body.to_string()).await
    }
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
