//! A client over real TCP: Noise IK upgrade on /ts2021, HTTP/2 inside Noise, then a register request.

use std::net::SocketAddr;
use std::sync::Arc;

use base64::Engine;
use coord_api::CoordinatorState;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const NOISE_PATTERN: &str = "Noise_IK_25519_ChaChaPoly_BLAKE2s";
const VERSION: u16 = 68;

async fn start() -> (SocketAddr, Arc<CoordinatorState>) {
    let state = Arc::new(CoordinatorState::new(coord_noise::generate_control_key()));
    let app = coord_api::router(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await.ok();
    });
    (addr, state)
}

/// Send the upgrade request and return the status line and the stream after the headers.
async fn upgrade(addr: SocketAddr, initiation: &[u8]) -> (String, tokio::net::TcpStream) {
    let mut tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
    let b64 = base64::engine::general_purpose::STANDARD.encode(initiation);
    let req = format!(
        "POST /ts2021 HTTP/1.1\r\nHost: control.test\r\nUpgrade: tailscale-control-protocol\r\nConnection: upgrade\r\n\
         X-Tailscale-Handshake: {b64}\r\nContent-Length: 0\r\n\r\n"
    );
    tcp.write_all(req.as_bytes()).await.unwrap();
    // Read the headers one byte at a time: the Noise response follows them directly
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        head.push(tcp.read_u8().await.unwrap());
    }
    let head = String::from_utf8(head).unwrap();
    (head.lines().next().unwrap().to_string(), tcp)
}

fn initiator(machine_secret: &[u8; 32], server_public: &[u8; 32], version: u16) -> snow::HandshakeState {
    snow::Builder::new(NOISE_PATTERN.parse().unwrap())
        .local_private_key(machine_secret)
        .unwrap()
        .remote_public_key(server_public)
        .unwrap()
        .prologue(format!("Tailscale Control Protocol v{version}").as_bytes())
        .unwrap()
        .build_initiator()
        .unwrap()
}

fn initiation_message(hs: &mut snow::HandshakeState, version: u16) -> Vec<u8> {
    let mut payload = [0u8; 256];
    let len = hs.write_message(&[], &mut payload).unwrap();
    let mut msg = version.to_be_bytes().to_vec();
    msg.push(1);
    msg.extend_from_slice(&u16::try_from(len).unwrap().to_be_bytes());
    msg.extend_from_slice(&payload[..len]);
    msg
}

#[tokio::test]
async fn a_client_registers_over_noise_and_http2_on_real_tcp() {
    let (addr, state) = start().await;
    let tenant = state.store().create_tenant("noise-e2e".into(), None, None).await.unwrap().id;
    let auth_key = state.store().create_preauth_key(tenant, false).await.unwrap();

    let machine_secret = [21u8; 32];
    let machine_public = coord_noise::control_key_from_secret(machine_secret).public;
    let mut hs = initiator(&machine_secret, &state.control_key().public, VERSION);
    let (status, mut tcp) = upgrade(addr, &initiation_message(&mut hs, VERSION)).await;
    assert!(status.contains("101"), "{status}");

    // Noise response: type 2, length 48, then the payload
    let mut response = [0u8; 51];
    tcp.read_exact(&mut response).await.unwrap();
    assert_eq!(response[0], 2);
    hs.read_message(&response[3..], &mut [0u8; 64]).unwrap();
    let (initiator_key, responder_key) = hs.dangerously_get_raw_split();
    let transport = coord_noise::NoiseTransport::new(initiator_key, responder_key);
    let clear = coord_noise::spawn_noise_bridge(tcp, transport);

    let (h2, conn) = h2::client::handshake(clear).await.unwrap();
    tokio::spawn(conn);
    let mut h2 = h2.ready().await.unwrap();
    let body = serde_json::json!({
        "Version": VERSION,
        "NodeKey": format!("nodekey:{}", hex::encode([22u8; 32])),
        "Auth": { "AuthKey": auth_key },
        "Hostinfo": { "Hostname": "e2e-laptop", "OS": "linux" }
    })
    .to_string();
    let req = axum::http::Request::builder().method("POST").uri("http://control.test/machine/register").body(()).unwrap();
    let (resp, mut send) = h2.send_request(req, false).unwrap();
    send.send_data(bytes::Bytes::from(body), true).unwrap();
    let resp = resp.await.unwrap();
    assert_eq!(resp.status(), 200);
    let mut recv = resp.into_body();
    let mut out = Vec::new();
    while let Some(chunk) = recv.data().await {
        let chunk = chunk.unwrap();
        recv.flow_control().release_capacity(chunk.len()).unwrap();
        out.extend_from_slice(&chunk);
    }
    let json: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(json["MachineAuthorized"], true, "{json}");

    // The node is registered under the machine key proven in the handshake
    let node = state.store().get_node_by_machine_key(&machine_public).await.expect("registered");
    assert_eq!(state.store().get_node_tenant(node).await, Some(tenant));
}

#[tokio::test]
async fn upgrades_with_a_broken_handshake_are_refused() {
    let (addr, state) = start().await;
    let server = state.control_key().public;

    // Header version differs from the prologue version
    let mut hs = initiator(&[23u8; 32], &server, VERSION);
    let mut msg = initiation_message(&mut hs, VERSION);
    msg[0..2].copy_from_slice(&(VERSION + 1).to_be_bytes());
    assert!(upgrade(addr, &msg).await.0.contains("400"));

    // Truncated
    let mut hs = initiator(&[23u8; 32], &server, VERSION);
    let msg = initiation_message(&mut hs, VERSION);
    assert!(upgrade(addr, &msg[..msg.len() - 1]).await.0.contains("400"));

    // Wrong message type
    let mut msg = msg;
    msg[2] = 4;
    assert!(upgrade(addr, &msg).await.0.contains("400"));
}
