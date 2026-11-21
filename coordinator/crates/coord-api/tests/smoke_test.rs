//! Smoke test over a real TCP server: bind, routing, middleware, handler, JSON response.

use std::sync::Arc;
use coord_api::CoordinatorState;
async fn start_server() -> (String, tokio::task::JoinHandle<()>) {
    let key = coord_noise::generate_control_key();
    let state = Arc::new(
        CoordinatorState::builder(key).with_admin_api_key(Some("smoke-test-key".into())).build(),
    );
    let app = coord_api::router(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().unwrap();
    let base = format!("http://{}", addr);

    let handle = tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });

    (base, handle)
}

#[tokio::test]
async fn health_over_tcp() {
    let (base, handle) = start_server().await;

    let resp = reqwest::get(format!("{}/health", base))
        .await
        .expect("health request");
    assert_eq!(resp.status(), 200);
    let json: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(json["status"], "ok");

    handle.abort();
}

#[tokio::test]
async fn key_endpoint_over_tcp() {
    let (base, handle) = start_server().await;

    let resp = reqwest::get(format!("{}/key", base))
        .await
        .expect("key request");
    assert_eq!(resp.status(), 200);

    let body: serde_json::Value = resp.json().await.unwrap();
    let public_key = body["publicKey"].as_str().unwrap();
    assert!(public_key.starts_with("mkey:"));
    assert_eq!(public_key.len(), "mkey:".len() + 64); // 32 bytes hex
    assert_eq!(body["legacyPublicKey"], body["publicKey"]);

    handle.abort();
}

#[tokio::test]
async fn admin_auth_required_over_tcp() {
    let (base, handle) = start_server().await;
    let client = reqwest::Client::new();

    let resp = client
        .get(format!("{}/api/nodes", base))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 401);

    let resp = client
        .get(format!("{}/api/nodes", base))
        .header("Authorization", "Bearer wrong-key")
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 401);

    let resp = client
        .get(format!("{}/api/nodes", base))
        .header("Authorization", "Bearer smoke-test-key")
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);

    handle.abort();
}

#[tokio::test]
async fn tenant_lifecycle_over_tcp() {
    let (base, handle) = start_server().await;
    let client = reqwest::Client::new();
    let auth = "Bearer smoke-test-key";

    let resp = client
        .post(format!("{}/api/tenants", base))
        .header("Authorization", auth)
        .json(&serde_json::json!({"slug": "smoke-tenant"}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 201);
    let tenant: serde_json::Value = resp.json().await.unwrap();
    let tenant_id = tenant["id"].as_str().unwrap().to_string();
    assert_eq!(tenant["slug"], "smoke-tenant");

    let resp = client
        .get(format!("{}/api/tenants/{}", base, tenant_id))
        .header("Authorization", auth)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let fetched: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(fetched["tenant"]["slug"], "smoke-tenant");

    let resp = client
        .get(format!("{}/api/tenants", base))
        .header("Authorization", auth)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    let list = body["tenants"].as_array().unwrap();
    assert!(list.iter().any(|t| t["slug"] == "smoke-tenant"));

    let resp = client
        .post(format!("{}/api/preauth-keys", base))
        .header("Authorization", auth)
        .json(&serde_json::json!({"tenant_id": tenant_id}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 201);
    let key_resp: serde_json::Value = resp.json().await.unwrap();
    assert!(key_resp["key"].as_str().unwrap().starts_with("tskey-auth-"));

    let resp = client
        .delete(format!("{}/api/tenants/{}", base, tenant_id))
        .header("Authorization", auth)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);

    let resp = client
        .get(format!("{}/api/tenants/{}", base, tenant_id))
        .header("Authorization", auth)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404);

    handle.abort();
}

#[tokio::test]
async fn body_limit_enforced_over_tcp() {
    let (base, handle) = start_server().await;
    let client = reqwest::Client::new();

    // The body limit is 2 MiB.
    let big_body = vec![b'x'; 3 * 1024 * 1024];
    let result = client
        .post(format!("{}/api/tenants", base))
        .header("Authorization", "Bearer smoke-test-key")
        .header("Content-Type", "application/json")
        .body(big_body)
        .send()
        .await;
    // The server answers 413 and closes. If it closes before the client sends the whole body,
    // the client sees a reset. Both outcomes mean the server refused the body.
    match result {
        Ok(resp) => assert_eq!(resp.status(), 413),
        Err(e) => assert!(e.is_request() || e.is_body() || e.is_connect(), "unexpected error: {e:?}"),
    }

    handle.abort();
}

// The built-in DERP relay over a real TCP connection (ADR-0027).

mod derp_e2e {
    use super::*;
    use coord_core::{NodeInfo, NodeRegistration};
    use coord_derp::frame::*;
    use crypto_box::aead::Aead;
    use crypto_box::{PublicKey, SalsaBox, SecretKey};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    async fn register(state: &Arc<CoordinatorState>, tenant: coord_core::TenantId, seed: u8) -> SecretKey {
        let secret = SecretKey::from([seed; 32]);
        let info = NodeInfo {
            node_key: secret.public_key().as_bytes().to_vec(),
            machine_key: vec![seed; 32],
            disco_key: None,
            endpoints: vec![],
            hostname: format!("node-{seed}"),
            os: "linux".into(),
            ipv4: None,
            ipv6: None,
        };
        state.store().register_node_with(tenant, [seed; 32], info, NodeRegistration::default()).await.unwrap();
        secret
    }

    /// HTTP upgrade + DERP handshake, as a Tailscale client does it. Returns
    /// the stream, or the HTTP status line / handshake failure.
    async fn connect(addr: &str, secret: &SecretKey) -> Result<TcpStream, String> {
        let mut s = TcpStream::connect(addr).await.unwrap();
        s.write_all(b"GET /derp HTTP/1.1\r\nHost: derp.test\r\nUpgrade: DERP\r\nConnection: Upgrade\r\n\r\n").await.unwrap();
        let mut head = Vec::new();
        let mut b = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            s.read_exact(&mut b).await.map_err(|e| e.to_string())?;
            head.push(b[0]);
        }
        let head = String::from_utf8_lossy(&head).to_string();
        if !head.starts_with("HTTP/1.1 101") {
            return Err(head);
        }
        assert!(head.to_ascii_lowercase().contains("upgrade: derp"));
        assert!(head.to_ascii_lowercase().contains("derp-version: 2"));

        let (ty, len) = read_header(&mut s).await.map_err(|e| e.to_string())?;
        assert_eq!((ty, len), (FRAME_SERVER_KEY, 40));
        let mut body = [0u8; 40];
        s.read_exact(&mut body).await.unwrap();
        assert_eq!(&body[..8], MAGIC);
        let server_key: [u8; 32] = body[8..].try_into().unwrap();
        assert!(head.contains(&hex::encode(server_key)), "Derp-Public-Key header matches the key frame");

        let salsa = SalsaBox::new(&PublicKey::from(server_key), secret);
        let nonce = [7u8; 24];
        let sealed = salsa.encrypt(crypto_box::Nonce::from_slice(&nonce), &br#"{"version":2}"#[..]).unwrap();
        write_frame(&mut s, FRAME_CLIENT_INFO, &[secret.public_key().as_bytes(), &nonce, &sealed]).await.unwrap();

        let (ty, len) = read_header(&mut s).await.map_err(|e| format!("closed during handshake: {e}"))?;
        if ty != FRAME_SERVER_INFO {
            return Err(format!("unexpected frame {ty:#x}"));
        }
        let mut info = vec![0u8; len as usize];
        s.read_exact(&mut info).await.unwrap();
        salsa.decrypt(crypto_box::Nonce::from_slice(&info[..24]), &info[24..]).map_err(|_| "server info did not decrypt".to_string())?;
        Ok(s)
    }

    #[tokio::test]
    async fn registered_nodes_relay_through_the_coordinator_and_strangers_are_refused() {
        let state = Arc::new(CoordinatorState::new(coord_noise::generate_control_key()));
        let tenant = state.store().create_tenant("derp-e2e".into(), None, None).await.unwrap().id;
        let a = register(&state, tenant, 11).await;
        let b = register(&state, tenant, 22).await;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let app = coord_api::router(state.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.ok();
        });

        let mut ca = connect(&addr, &a).await.expect("node a connects");
        let mut cb = connect(&addr, &b).await.expect("node b connects");
        for _ in 0..200 {
            if state.relay().connected_clients() == 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }

        write_frame(&mut ca, FRAME_SEND_PACKET, &[b.public_key().as_bytes(), b"over tcp"]).await.unwrap();
        let (ty, len) = tokio::time::timeout(std::time::Duration::from_secs(3), read_header(&mut cb)).await.unwrap().unwrap();
        assert_eq!(ty, FRAME_RECV_PACKET);
        let mut body = vec![0u8; len as usize];
        cb.read_exact(&mut body).await.unwrap();
        assert_eq!(&body[..32], a.public_key().as_bytes());
        assert_eq!(&body[32..], b"over tcp");

        // A key that is not registered with the coordinator cannot use the relay
        let stranger = SecretKey::from([99u8; 32]);
        assert!(connect(&addr, &stranger).await.is_err());

        server.abort();
    }
}
