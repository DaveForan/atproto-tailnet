//! Smoke test — starts a real TCP server and exercises key HTTP endpoints.
//!
//! Verifies end-to-end: TCP bind → axum routing → middleware → handler → JSON response.

use std::sync::Arc;
use coord_api::CoordinatorState;
async fn start_server() -> (String, tokio::task::JoinHandle<()>) {
    let key = coord_noise::generate_control_key();
    let state = Arc::new(
        CoordinatorState::new(key).with_admin_api_key(Some("smoke-test-key".into())),
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

    // Create tenant
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

    // Get tenant
    let resp = client
        .get(format!("{}/api/tenants/{}", base, tenant_id))
        .header("Authorization", auth)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let fetched: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(fetched["tenant"]["slug"], "smoke-tenant");

    // List tenants
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

    // Create preauth key
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

    // Delete tenant
    let resp = client
        .delete(format!("{}/api/tenants/{}", base, tenant_id))
        .header("Authorization", auth)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);

    // Verify deleted
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

    // 3 MiB body should be rejected (limit is 2 MiB)
    let big_body = vec![b'x'; 3 * 1024 * 1024];
    let resp = client
        .post(format!("{}/api/tenants", base))
        .header("Authorization", "Bearer smoke-test-key")
        .header("Content-Type", "application/json")
        .body(big_body)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 413);

    handle.abort();
}
