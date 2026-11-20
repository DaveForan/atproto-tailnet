use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;

use coord_api::CoordinatorState;
#[allow(unused_imports)]
use coord_federation::FederationStore;

const TEST_ADMIN_KEY: &str = "test-admin-key";

fn setup() -> (axum::Router, Arc<CoordinatorState>) {
    let key = coord_noise::generate_control_key();
    let state = Arc::new(
        CoordinatorState::new(key)
            .with_admin_api_key(Some(TEST_ADMIN_KEY.to_string()))
            .with_federation_callbacks(Arc::new(TestCallbacks)),
    );
    let app = coord_api::router(state.clone());
    (app, state)
}

struct TestCallbacks;

#[async_trait::async_trait]
impl coord_federation::HandshakeCallbacks for TestCallbacks {
    async fn sign(&self, _payload: &str) -> Result<String, coord_core::CoordError> {
        Ok("test-sig".to_string())
    }
    async fn verify_signature(&self, _did: &str, _payload: &str, _signature: &str) -> Result<bool, coord_core::CoordError> {
        Ok(true)
    }
    async fn evaluate_policy(&self, _remote_did: &str, _federation_type: &coord_federation::protocol::FederationType) -> Result<bool, coord_core::CoordError> {
        Ok(true)
    }
    fn get_local_routes(&self) -> Vec<coord_federation::protocol::RouteAnnouncement> {
        vec![]
    }
}

fn setup_with_callbacks() -> (axum::Router, Arc<CoordinatorState>) {
    let key = coord_noise::generate_control_key();
    let state = Arc::new(
        CoordinatorState::new(key)
            .with_admin_api_key(Some(TEST_ADMIN_KEY.to_string()))
            .with_federation_callbacks(Arc::new(TestCallbacks)),
    );
    let app = coord_api::router(state.clone());
    (app, state)
}

/// Like `setup`, with the built-in relay as the default DERP region (region 1).
fn setup_with_relay_region() -> (axum::Router, Arc<CoordinatorState>) {
    let key = coord_noise::generate_control_key();
    let state = Arc::new(
        CoordinatorState::new(key)
            .with_admin_api_key(Some(TEST_ADMIN_KEY.to_string()))
            .with_builtin_relay_region("derp.example.com", 3478),
    );
    (coord_api::router(state.clone()), state)
}

fn admin_req() -> axum::http::request::Builder {
    Request::builder().header("authorization", format!("Bearer {}", TEST_ADMIN_KEY))
}

/// Create a tenant in the store and return its ID (tests need real tenants since R6).
async fn create_test_tenant(state: &Arc<CoordinatorState>, slug: &str) -> coord_core::TenantId {
    state.store().create_tenant(slug.into(), None, None).await.unwrap().id
}

#[tokio::test]
async fn health_endpoint() {
    let (app, _) = setup();
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), 1024).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["status"], "ok");
}

#[tokio::test]
async fn key_endpoint_returns_json() {
    let (app, state) = setup();
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/key?v=68")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), 1024)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let expected_mkey = format!("mkey:{}", hex::encode(state.control_key().public));
    assert_eq!(json["publicKey"], expected_mkey);
    assert_eq!(json["legacyPublicKey"], expected_mkey);
}

#[tokio::test]
async fn create_preauth_key_requires_tenant_id() {
    let (app, _) = setup();

    // Missing tenant_id should fail (no longer auto-creates tenants)
    let resp = app.clone()
        .oneshot(
            admin_req()
                .method("POST")
                .uri("/api/preauth-keys")
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNPROCESSABLE_ENTITY);

    // Nonexistent tenant_id should return 404
    let resp = app
        .oneshot(
            admin_req()
                .method("POST")
                .uri("/api/preauth-keys")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"tenant_id":"00000000-0000-0000-0000-000000000000"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn register_with_preauth_key() {
    let (_, state) = setup();
    let tenant_id = create_test_tenant(&state, "register-test").await;
    let auth_key = state.store().create_preauth_key(tenant_id, false).await.unwrap();

    let machine_key = [42u8; 32];
    let node_key_hex = hex::encode([7u8; 32]);

    let register_body = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", node_key_hex),
        "Auth": { "AuthKey": auth_key },
        "Hostinfo": {
            "Hostname": "test-node",
            "OS": "linux"
        }
    });

    let result =
        coord_api::__test_handle_register(&state, &machine_key, &register_body.to_string()).await;

    assert!(result.is_ok(), "register failed: {:?}", result.err());
    let resp_text = result.unwrap();
    let resp: serde_json::Value = serde_json::from_str(&resp_text).unwrap();

    assert_eq!(resp["MachineAuthorized"], true);
    assert_eq!(resp["Error"], "");
    assert_eq!(resp["AuthURL"], "");
    assert!(resp["User"]["ID"].as_i64().unwrap() > 0);
    assert!(!resp["Login"]["LoginName"].as_str().unwrap().is_empty());
}

#[tokio::test]
async fn register_rejects_bad_key() {
    let (_, state) = setup();
    let machine_key = [1u8; 32];
    let node_key_hex = hex::encode([2u8; 32]);

    let register_body = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", node_key_hex),
        "Auth": { "AuthKey": "tskey-auth-bogus" },
        "Hostinfo": { "Hostname": "bad-node", "OS": "linux" }
    });

    let result =
        coord_api::__test_handle_register(&state, &machine_key, &register_body.to_string()).await;

    assert!(result.is_ok());
    let resp: serde_json::Value = serde_json::from_str(&result.unwrap()).unwrap();
    assert_eq!(resp["MachineAuthorized"], false);
    assert!(resp["Error"].as_str().unwrap().contains("invalid"));
}

#[tokio::test]
async fn map_returns_netmap() {
    let (_, state) = setup();
    let tenant_id = create_test_tenant(&state, "map-netmap").await;
    let auth_key = state.store().create_preauth_key(tenant_id, true).await.unwrap();

    let machine_key_1 = [10u8; 32];
    let machine_key_2 = [20u8; 32];

    for (mkey, nkey_byte, hostname) in [
        (machine_key_1, 11u8, "node-a"),
        (machine_key_2, 22u8, "node-b"),
    ] {
        let body = serde_json::json!({
            "Version": 2,
            "NodeKey": format!("nodekey:{}", hex::encode([nkey_byte; 32])),
            "Auth": { "AuthKey": &auth_key },
            "Hostinfo": { "Hostname": hostname, "OS": "linux" }
        });
        coord_api::__test_handle_register(&state, &mkey, &body.to_string())
            .await
            .unwrap();
    }

    let map_body = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([11u8; 32])),
    });

    let result =
        coord_api::__test_handle_map(&state, &machine_key_1, &map_body.to_string()).await;

    assert!(result.is_ok(), "map failed: {:?}", result.err());
    let resp: serde_json::Value = serde_json::from_str(&result.unwrap()).unwrap();

    assert!(resp["Node"].is_object());
    assert!(resp["Node"]["StableID"].is_string());
    assert!(resp["Node"]["User"].as_i64().is_some());
    assert!(resp["DERPMap"].is_object());
    assert!(resp["Domain"].is_string());

    let peers = resp["Peers"].as_array().unwrap();
    assert_eq!(peers.len(), 1);
    assert_eq!(peers[0]["Name"], "node-b.mesh.local.");
}

#[tokio::test]
async fn map_keepalive() {
    let (_, state) = setup();
    let tenant_id = create_test_tenant(&state, "map-keepalive").await;
    let auth_key = state.store().create_preauth_key(tenant_id, false).await.unwrap();
    let machine_key = [99u8; 32];

    let reg_body = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([99u8; 32])),
        "Auth": { "AuthKey": &auth_key },
        "Hostinfo": { "Hostname": "keepalive-node", "OS": "linux" }
    });
    coord_api::__test_handle_register(&state, &machine_key, &reg_body.to_string())
        .await
        .unwrap();

    let map_body = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([99u8; 32])),
        "KeepAlive": true,
    });

    let result = coord_api::__test_handle_map(&state, &machine_key, &map_body.to_string())
        .await
        .unwrap();
    let resp: serde_json::Value = serde_json::from_str(&result).unwrap();
    // KeepAlive in the request is a preference flag, not a request type —
    // server returns the full map snapshot regardless
    assert!(resp["Node"].is_object(), "KeepAlive:true should still return full map");
}

#[tokio::test]
async fn tenant_isolation_in_map() {
    let (_, state) = setup();

    let t1 = create_test_tenant(&state, "iso-t1").await;
    let t2 = create_test_tenant(&state, "iso-t2").await;
    let key1 = state.store().create_preauth_key(t1, false).await.unwrap();
    let key2 = state.store().create_preauth_key(t2, false).await.unwrap();

    let mk1 = [50u8; 32];
    let mk2 = [60u8; 32];

    let reg1 = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([51u8; 32])),
        "Auth": { "AuthKey": &key1 },
        "Hostinfo": { "Hostname": "t1-node", "OS": "linux" }
    });
    let reg2 = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([61u8; 32])),
        "Auth": { "AuthKey": &key2 },
        "Hostinfo": { "Hostname": "t2-node", "OS": "linux" }
    });

    coord_api::__test_handle_register(&state, &mk1, &reg1.to_string())
        .await
        .unwrap();
    coord_api::__test_handle_register(&state, &mk2, &reg2.to_string())
        .await
        .unwrap();

    let map_body = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([51u8; 32])),
    });
    let result = coord_api::__test_handle_map(&state, &mk1, &map_body.to_string())
        .await
        .unwrap();
    let resp: serde_json::Value = serde_json::from_str(&result).unwrap();

    assert!(
        resp["Peers"].is_null(),
        "tenant 1 node should not see tenant 2 node as a peer"
    );
}

#[tokio::test]
async fn delta_response_on_peer_join() {
    let (_, state) = setup();
    let tenant_id = create_test_tenant(&state, "delta-join").await;
    let auth_key = state.store().create_preauth_key(tenant_id, true).await.unwrap();

    let mk1 = [70u8; 32];
    let mk2 = [80u8; 32];

    let reg1 = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([71u8; 32])),
        "Auth": { "AuthKey": &auth_key },
        "Hostinfo": { "Hostname": "delta-node-a", "OS": "linux" }
    });
    coord_api::__test_handle_register(&state, &mk1, &reg1.to_string())
        .await
        .unwrap();

    let reg2 = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([81u8; 32])),
        "Auth": { "AuthKey": &auth_key },
        "Hostinfo": { "Hostname": "delta-node-b", "OS": "linux" }
    });
    coord_api::__test_handle_register(&state, &mk2, &reg2.to_string())
        .await
        .unwrap();

    let node2_id = state.store().get_node_by_machine_key(&mk2).await.unwrap();
    let event = coord_store::PeerEvent::NodeJoined {
        tenant_id,
        node_id: node2_id,
    };

    let delta = coord_api::__test_build_delta(&state, &mk1, &event).await;
    assert!(delta.is_some());
    let resp: serde_json::Value = serde_json::from_str(&delta.unwrap()).unwrap();
    let changed = resp["PeersChanged"].as_array().unwrap();
    assert_eq!(changed.len(), 1);
    assert!(changed[0]["Addresses"].as_array().unwrap()[0]
        .as_str()
        .unwrap()
        .starts_with("100.64."));
}

#[tokio::test]
async fn delta_response_on_peer_offline() {
    let (_, state) = setup();
    let tenant_id = create_test_tenant(&state, "delta-offline").await;
    let auth_key = state.store().create_preauth_key(tenant_id, true).await.unwrap();

    let mk1 = [90u8; 32];
    let reg1 = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([91u8; 32])),
        "Auth": { "AuthKey": &auth_key },
        "Hostinfo": { "Hostname": "offline-test", "OS": "linux" }
    });
    coord_api::__test_handle_register(&state, &mk1, &reg1.to_string())
        .await
        .unwrap();

    let node_id = state.store().get_node_by_machine_key(&mk1).await.unwrap();
    let event = coord_store::PeerEvent::NodeOffline {
        tenant_id,
        node_id,
    };

    let delta = coord_api::__test_build_delta(&state, &[0u8; 32], &event).await;
    assert!(delta.is_some());
    let resp: serde_json::Value = serde_json::from_str(&delta.unwrap()).unwrap();
    let removed = resp["PeersRemoved"].as_array().unwrap();
    assert_eq!(removed.len(), 1);
    assert_eq!(removed[0].as_i64().unwrap(), node_id.as_i64());
}

#[tokio::test]
async fn map_with_endpoints() {
    let (_, state) = setup();
    let tenant_id = create_test_tenant(&state, "map-endpoints").await;
    let auth_key = state.store().create_preauth_key(tenant_id, true).await.unwrap();

    let mk1 = [110u8; 32];
    let mk2 = [120u8; 32];

    for (mkey, nkey_byte, hostname) in [
        (mk1, 111u8, "ep-node-a"),
        (mk2, 122u8, "ep-node-b"),
    ] {
        let body = serde_json::json!({
            "Version": 2,
            "NodeKey": format!("nodekey:{}", hex::encode([nkey_byte; 32])),
            "Auth": { "AuthKey": &auth_key },
            "Hostinfo": { "Hostname": hostname, "OS": "linux" }
        });
        coord_api::__test_handle_register(&state, &mkey, &body.to_string())
            .await
            .unwrap();
    }

    // Node 2 sends endpoints via map request
    let map_body = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([122u8; 32])),
        "Endpoints": ["192.168.1.5:41641", "10.0.0.5:41641"],
    });
    coord_api::__test_handle_map(&state, &mk2, &map_body.to_string())
        .await
        .unwrap();

    // Node 1 maps and should see node 2's endpoints
    let map_body1 = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([111u8; 32])),
    });
    let result = coord_api::__test_handle_map(&state, &mk1, &map_body1.to_string())
        .await
        .unwrap();
    let resp: serde_json::Value = serde_json::from_str(&result).unwrap();
    let peers = resp["Peers"].as_array().unwrap();
    assert_eq!(peers.len(), 1);
    let endpoints = peers[0]["Endpoints"].as_array().unwrap();
    assert_eq!(endpoints.len(), 2);
    assert_eq!(endpoints[0], "192.168.1.5:41641");
}

#[tokio::test]
async fn node_key_rotation() {
    let (_, state) = setup();
    let tenant_id = create_test_tenant(&state, "key-rotation").await;
    let auth_key = state.store().create_preauth_key(tenant_id, true).await.unwrap();

    let machine_key = [130u8; 32];
    let old_node_key = [131u8; 32];
    let new_node_key = [132u8; 32];

    // Register with original node key
    let reg_body = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode(old_node_key)),
        "Auth": { "AuthKey": &auth_key },
        "Hostinfo": { "Hostname": "rotating-node", "OS": "linux" }
    });
    coord_api::__test_handle_register(&state, &machine_key, &reg_body.to_string())
        .await
        .unwrap();

    let node_id = state.store().get_node_by_machine_key(&machine_key).await.unwrap();
    let info_before = state.store().get_node_info(node_id).await.unwrap().info;
    assert_eq!(info_before.node_key, old_node_key.to_vec());

    // Re-register with new node key, providing OldNodeKey
    let rotate_body = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode(new_node_key)),
        "OldNodeKey": format!("nodekey:{}", hex::encode(old_node_key)),
        "Auth": { "AuthKey": &auth_key },
        "Hostinfo": { "Hostname": "rotating-node", "OS": "linux" }
    });
    let result = coord_api::__test_handle_register(&state, &machine_key, &rotate_body.to_string())
        .await
        .unwrap();
    let resp: serde_json::Value = serde_json::from_str(&result).unwrap();
    assert_eq!(resp["MachineAuthorized"], true);

    // Verify the node key was updated
    let info_after = state.store().get_node_info(node_id).await.unwrap().info;
    assert_eq!(info_after.node_key, new_node_key.to_vec());

    // Same node ID and IP should be preserved
    let same_node_id = state.store().get_node_by_machine_key(&machine_key).await.unwrap();
    assert_eq!(node_id, same_node_id);
}

#[tokio::test]
async fn map_includes_home_derp() {
    let key = coord_noise::generate_control_key();
    let state = Arc::new(CoordinatorState::new(key).with_builtin_relay_region("derp.example.com", 3478));
    let tenant_id = create_test_tenant(&state, "home-derp").await;
    let auth_key = state.store().create_preauth_key(tenant_id, false).await.unwrap();
    let machine_key = [140u8; 32];

    let reg = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([141u8; 32])),
        "Auth": { "AuthKey": &auth_key },
        "Hostinfo": { "Hostname": "derp-test-node", "OS": "linux" }
    });
    coord_api::__test_handle_register(&state, &machine_key, &reg.to_string())
        .await
        .unwrap();

    let map_body = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([141u8; 32])),
    });
    let result = coord_api::__test_handle_map(&state, &machine_key, &map_body.to_string())
        .await
        .unwrap();
    let resp: serde_json::Value = serde_json::from_str(&result).unwrap();

    // Node should have HomeDERP field
    assert!(resp["Node"]["HomeDERP"].as_i64().is_some());
    let home_derp = resp["Node"]["HomeDERP"].as_i64().unwrap();
    assert!(home_derp > 0);

    // Legacy DERP field should match 127.3.3.40:<region>
    let derp_str = resp["Node"]["DERP"].as_str().unwrap();
    assert_eq!(derp_str, format!("127.3.3.40:{}", home_derp));

    // DERPMap should have OmitDefaultRegions set
    assert_eq!(resp["DERPMap"]["OmitDefaultRegions"], true);

    // DERPMap should have the region matching HomeDERP
    let regions = resp["DERPMap"]["Regions"].as_object().unwrap();
    assert!(regions.contains_key(&home_derp.to_string()));
}

#[tokio::test]
async fn disco_key_propagation() {
    let (_, state) = setup();
    let tenant_id = create_test_tenant(&state, "disco-key").await;
    let auth_key = state.store().create_preauth_key(tenant_id, true).await.unwrap();

    let mk1 = [160u8; 32];
    let mk2 = [170u8; 32];

    for (mkey, nkey_byte, hostname) in [
        (mk1, 161u8, "disco-node-a"),
        (mk2, 171u8, "disco-node-b"),
    ] {
        let body = serde_json::json!({
            "Version": 2,
            "NodeKey": format!("nodekey:{}", hex::encode([nkey_byte; 32])),
            "Auth": { "AuthKey": &auth_key },
            "Hostinfo": { "Hostname": hostname, "OS": "linux" }
        });
        coord_api::__test_handle_register(&state, &mkey, &body.to_string())
            .await
            .unwrap();
    }

    // Node 2 sends disco key + endpoints
    let map_body = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([171u8; 32])),
        "DiscoKey": "discokey:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        "Endpoints": ["192.168.1.10:41641"],
    });
    coord_api::__test_handle_map(&state, &mk2, &map_body.to_string())
        .await
        .unwrap();

    // Node 1 should see node 2's disco key
    let map_body1 = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([161u8; 32])),
    });
    let result = coord_api::__test_handle_map(&state, &mk1, &map_body1.to_string())
        .await
        .unwrap();
    let resp: serde_json::Value = serde_json::from_str(&result).unwrap();
    let peers = resp["Peers"].as_array().unwrap();
    assert_eq!(peers.len(), 1);
    let disco = peers[0]["DiscoKey"].as_str().unwrap();
    assert!(disco.starts_with("discokey:"));
}

#[tokio::test]
async fn acl_policy_restricts_filter() {
    let (_, state) = setup();
    let tenant_id = create_test_tenant(&state, "acl-test").await;
    let auth_key = state.store().create_preauth_key(tenant_id, false).await.unwrap();
    let machine_key = [180u8; 32];

    let reg = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([181u8; 32])),
        "Auth": { "AuthKey": &auth_key },
        "Hostinfo": { "Hostname": "acl-test-node", "OS": "linux" }
    });
    coord_api::__test_handle_register(&state, &machine_key, &reg.to_string())
        .await
        .unwrap();

    // Without policy: should get allow-all filter
    let map_body = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([181u8; 32])),
    });
    let result = coord_api::__test_handle_map(&state, &machine_key, &map_body.to_string())
        .await
        .unwrap();
    let resp: serde_json::Value = serde_json::from_str(&result).unwrap();
    let filters = resp["PacketFilter"].as_array().unwrap();
    assert_eq!(filters.len(), 1);
    assert_eq!(filters[0]["SrcIPs"][0], "*");

    // Set restrictive ACL: only SSH (22) and HTTP (80-443)
    let policy = coord_acl::AclPolicy {
        default_deny: false,
        rules: vec![
            coord_acl::AclRule {
                src: "*".into(),
                dst: "*".into(),
                ports: vec![
                    coord_acl::PortSpec::Single(22),
                    coord_acl::PortSpec::Range(80, 443),
                ],
            },
        ],
    };
    state.acl().set_policy(tenant_id, policy);

    // Map again: should get the restricted filter
    let result2 = coord_api::__test_handle_map(&state, &machine_key, &map_body.to_string())
        .await
        .unwrap();
    let resp2: serde_json::Value = serde_json::from_str(&result2).unwrap();
    let filters2 = resp2["PacketFilter"].as_array().unwrap();
    assert_eq!(filters2.len(), 1);
    let dst_ports = filters2[0]["DstPorts"].as_array().unwrap();
    assert_eq!(dst_ports.len(), 2);
    assert_eq!(dst_ports[0]["Ports"]["First"], 22);
    assert_eq!(dst_ports[0]["Ports"]["Last"], 22);
    assert_eq!(dst_ports[1]["Ports"]["First"], 80);
    assert_eq!(dst_ports[1]["Ports"]["Last"], 443);
}

#[tokio::test]
async fn custom_derp_map() {
    use coord_proto::map::{DerpMap, DerpRegion, DerpNode};

    let key = coord_noise::generate_control_key();
    let mut custom_regions = std::collections::HashMap::new();
    custom_regions.insert(
        900,
        DerpRegion {
            region_id: 900,
            region_code: "self-hosted".into(),
            region_name: "Self-Hosted DERP".into(),
            nodes: vec![DerpNode {
                name: "900a".into(),
                region_id: 900,
                host_name: "derp.example.com".into(),
                cert_name: None,
                ipv4: None,
                ipv6: None,
                stun_port: 3478,
                derp_port: 443,
                stun_only: None,
                insecure_for_tests: None,
            }],
        },
    );
    let custom_derp = DerpMap {
        regions: custom_regions,
        omit_default_regions: Some(true),
    };

    let state = Arc::new(CoordinatorState::new(key).with_derp_map(custom_derp));
    let tenant_id = create_test_tenant(&state, "custom-derp").await;
    let auth_key = state.store().create_preauth_key(tenant_id, false).await.unwrap();
    let machine_key = [150u8; 32];

    let reg = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([151u8; 32])),
        "Auth": { "AuthKey": &auth_key },
        "Hostinfo": { "Hostname": "custom-derp-node", "OS": "linux" }
    });
    coord_api::__test_handle_register(&state, &machine_key, &reg.to_string())
        .await
        .unwrap();

    let map_body = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([151u8; 32])),
    });
    let result = coord_api::__test_handle_map(&state, &machine_key, &map_body.to_string())
        .await
        .unwrap();
    let resp: serde_json::Value = serde_json::from_str(&result).unwrap();

    // Should use the custom DERP region
    let regions = resp["DERPMap"]["Regions"].as_object().unwrap();
    assert!(regions.contains_key("900"));
    assert_eq!(regions["900"]["RegionCode"], "self-hosted");
    assert_eq!(regions["900"]["Nodes"][0]["HostName"], "derp.example.com");

    // Node's HomeDERP should reference region 900
    assert_eq!(resp["Node"]["HomeDERP"], 900);
    assert_eq!(resp["Node"]["DERP"], "127.3.3.40:900");
}

// ── Tenant CRUD tests ──

async fn json_body(resp: axum::http::Response<Body>) -> serde_json::Value {
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn tenant_crud_lifecycle() {
    let (app, _state) = setup();

    // Create a tenant
    let resp = app.clone().oneshot(
        admin_req()
            .method("POST")
            .uri("/api/tenants")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"slug":"test-collective"}"#))
            .unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);
    let body = json_body(resp).await;
    let tenant_id = body["id"].as_str().unwrap().to_string();
    assert_eq!(body["slug"], "test-collective");
    assert!(body["parent_id"].is_null());

    // List tenants
    let resp = app.clone().oneshot(
        admin_req()
            .uri("/api/tenants")
            .body(Body::empty())
            .unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    assert!(body["count"].as_u64().unwrap() >= 1);

    // Get single tenant
    let resp = app.clone().oneshot(
        admin_req()
            .uri(format!("/api/tenants/{}", tenant_id))
            .body(Body::empty())
            .unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    assert_eq!(body["tenant"]["slug"], "test-collective");
    assert!(body["children"].as_array().unwrap().is_empty());

    // Delete
    let resp = app.clone().oneshot(
        admin_req()
            .method("DELETE")
            .uri(format!("/api/tenants/{}", tenant_id))
            .body(Body::empty())
            .unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // Verify deleted
    let resp = app.clone().oneshot(
        admin_req()
            .uri(format!("/api/tenants/{}", tenant_id))
            .body(Body::empty())
            .unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn tenant_duplicate_slug_rejected() {
    let (app, _) = setup();

    let create = |slug: &str| {
        admin_req()
            .method("POST")
            .uri("/api/tenants")
            .header("content-type", "application/json")
            .body(Body::from(format!(r#"{{"slug":"{}"}}"#, slug)))
            .unwrap()
    };

    let resp = app.clone().oneshot(create("dup-test")).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);

    let resp = app.clone().oneshot(create("dup-test")).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn tenant_parent_child_creation() {
    let (app, _) = setup();

    // Create parent
    let resp = app.clone().oneshot(
        admin_req()
            .method("POST")
            .uri("/api/tenants")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"slug":"parent-org"}"#))
            .unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);
    let parent = json_body(resp).await;
    let parent_id = parent["id"].as_str().unwrap().to_string();

    // Create child
    let resp = app.clone().oneshot(
        admin_req()
            .method("POST")
            .uri("/api/tenants")
            .header("content-type", "application/json")
            .body(Body::from(format!(r#"{{"slug":"child-team","parent_id":"{}"}}"#, parent_id)))
            .unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);
    let child = json_body(resp).await;
    assert_eq!(child["parent_id"], parent_id);

    // Get parent — should list the child
    let resp = app.clone().oneshot(
        admin_req()
            .uri(format!("/api/tenants/{}", parent_id))
            .body(Body::empty())
            .unwrap(),
    ).await.unwrap();
    let body = json_body(resp).await;
    let children = body["children"].as_array().unwrap();
    assert_eq!(children.len(), 1);
    assert_eq!(children[0]["slug"], "child-team");
}

// ── ACL, node delete, node rename tests ──

#[tokio::test]
async fn get_acl_returns_policy() {
    let (app, state) = setup();
    let tenant_id = create_test_tenant(&state, "acl-get-test").await;

    // Set a policy via the existing POST /api/acl endpoint
    let set_body = serde_json::json!({
        "tenant_id": tenant_id.to_string(),
        "policy": {
            "default_deny": false,
            "rules": [{
                "src": "*",
                "dst": "*",
                "ports": [{"Single": 22}, {"Range": [80, 443]}]
            }]
        }
    });
    let resp = app.clone().oneshot(
        admin_req()
            .method("POST")
            .uri("/api/acl")
            .header("content-type", "application/json")
            .body(Body::from(set_body.to_string()))
            .unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // Read it back via GET /api/tenants/{id}/acl
    let resp = app.clone().oneshot(
        admin_req()
            .uri(format!("/api/tenants/{}/acl", tenant_id))
            .body(Body::empty())
            .unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    assert_eq!(body["default_deny"], false);
    let rules = body["rules"].as_array().unwrap();
    assert_eq!(rules.len(), 1);
    assert_eq!(rules[0]["src"], "*");
}

#[tokio::test]
async fn delete_node_removes_from_map() {
    let (app, state) = setup();
    let tenant_id = create_test_tenant(&state, "delete-node-test").await;
    let auth_key = state.store().create_preauth_key(tenant_id, true).await.unwrap();

    // Register two nodes
    let mk1 = [191u8; 32];
    let mk2 = [192u8; 32];
    for (mkey, nkey_byte, hostname) in [
        (mk1, 193u8, "del-node-a"),
        (mk2, 194u8, "del-node-b"),
    ] {
        let body = serde_json::json!({
            "Version": 2,
            "NodeKey": format!("nodekey:{}", hex::encode([nkey_byte; 32])),
            "Auth": { "AuthKey": &auth_key },
            "Hostinfo": { "Hostname": hostname, "OS": "linux" }
        });
        coord_api::__test_handle_register(&state, &mkey, &body.to_string())
            .await
            .unwrap();
    }

    // Get node2 ID
    let node2_id = state.store().get_node_by_machine_key(&mk2).await.unwrap();

    // Verify both nodes appear in the peers list
    let resp = app.clone().oneshot(
        admin_req()
            .uri(format!("/api/tenants/{}/nodes", tenant_id))
            .body(Body::empty())
            .unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    assert_eq!(body["count"].as_u64().unwrap(), 2);

    // Delete node2
    let resp = app.clone().oneshot(
        admin_req()
            .method("DELETE")
            .uri(format!("/api/nodes/{}", node2_id.as_i64()))
            .body(Body::empty())
            .unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    assert_eq!(body["status"], "deleted");

    // Verify only one node remains
    let resp = app.clone().oneshot(
        admin_req()
            .uri(format!("/api/tenants/{}/nodes", tenant_id))
            .body(Body::empty())
            .unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    assert_eq!(body["count"].as_u64().unwrap(), 1);
    let nodes = body["nodes"].as_array().unwrap();
    assert_eq!(nodes[0]["hostname"], "del-node-a");
}

#[tokio::test]
async fn rename_node_updates_hostname() {
    let (app, state) = setup();
    let tenant_id = create_test_tenant(&state, "rename-node-test").await;
    let auth_key = state.store().create_preauth_key(tenant_id, false).await.unwrap();

    let mk = [195u8; 32];
    let body = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([196u8; 32])),
        "Auth": { "AuthKey": &auth_key },
        "Hostinfo": { "Hostname": "old-name", "OS": "linux" }
    });
    coord_api::__test_handle_register(&state, &mk, &body.to_string())
        .await
        .unwrap();

    let node_id = state.store().get_node_by_machine_key(&mk).await.unwrap();

    // Rename it
    let resp = app.clone().oneshot(
        admin_req()
            .method("POST")
            .uri(format!("/api/nodes/{}/name", node_id.as_i64()))
            .header("content-type", "application/json")
            .body(Body::from(r#"{"name":"new-name"}"#))
            .unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    assert_eq!(body["hostname"], "new-name");

    // Verify via GET /api/nodes/{id}
    let resp = app.clone().oneshot(
        admin_req()
            .uri(format!("/api/nodes/{}", node_id.as_i64()))
            .body(Body::empty())
            .unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    assert_eq!(body["hostname"], "new-name");
}

// ── Hierarchy route aggregation tests ──

async fn register_node_for(
    state: &Arc<CoordinatorState>,
    tenant_id: coord_core::TenantId,
    machine_key: [u8; 32],
    nkey_byte: u8,
    hostname: &str,
) {
    let auth_key = state.store().create_preauth_key(tenant_id, true).await.unwrap();
    let body = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([nkey_byte; 32])),
        "Auth": { "AuthKey": &auth_key },
        "Hostinfo": { "Hostname": hostname, "OS": "linux" }
    });
    coord_api::__test_handle_register(state, &machine_key, &body.to_string())
        .await
        .unwrap();
}

#[tokio::test]
async fn hierarchy_parent_sees_child_peers_when_open() {
    let (_, state) = setup();

    // Create parent tenant and child with Open posture
    let parent = state.store().create_tenant("hier-parent".into(), None, None).await.unwrap();
    let child = state.store().create_tenant("hier-child".into(), Some(parent.id), None).await.unwrap();

    // Set child posture to Open (MemoryStore: update in place)
    {
        let store = state.store();
        if let coord_store::Store::Memory(m) = store.as_ref() {
            let mut tenants = m.tenants_for_test().lock().unwrap();
            tenants.get_mut(&child.id).unwrap().federation_posture =
                coord_core::FederationPosture::Open;
        }
    }

    // Register nodes: one in parent, one in child
    register_node_for(&state, parent.id, [200u8; 32], 201, "parent-node").await;
    register_node_for(&state, child.id, [210u8; 32], 211, "child-node").await;

    // Parent node maps — should see child-node as a peer
    let map_body = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([201u8; 32])),
    });
    let result = coord_api::__test_handle_map(&state, &[200u8; 32], &map_body.to_string())
        .await
        .unwrap();
    let resp: serde_json::Value = serde_json::from_str(&result).unwrap();
    let peers = resp["Peers"].as_array().unwrap();
    assert_eq!(peers.len(), 1, "parent should see child node as peer");
    assert_eq!(peers[0]["Name"], "child-node.mesh.local.");
}

#[tokio::test]
async fn hierarchy_parent_blocked_when_child_closed() {
    let (_, state) = setup();

    let parent = state.store().create_tenant("closed-parent".into(), None, None).await.unwrap();
    let child = state.store().create_tenant("closed-child".into(), Some(parent.id), None).await.unwrap();

    // Child stays Closed (default)
    assert_eq!(child.federation_posture, coord_core::FederationPosture::Closed);

    register_node_for(&state, parent.id, [220u8; 32], 221, "parent-closed").await;
    register_node_for(&state, child.id, [230u8; 32], 231, "child-closed").await;

    // Parent node maps — should NOT see child node (closed posture)
    let map_body = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([221u8; 32])),
    });
    let result = coord_api::__test_handle_map(&state, &[220u8; 32], &map_body.to_string())
        .await
        .unwrap();
    let resp: serde_json::Value = serde_json::from_str(&result).unwrap();
    assert!(
        resp["Peers"].is_null(),
        "parent should NOT see child peers when posture is Closed"
    );
}

#[tokio::test]
async fn hierarchy_child_does_not_see_parent_peers() {
    let (_, state) = setup();

    let parent = state.store().create_tenant("uni-parent".into(), None, None).await.unwrap();
    let child = state.store().create_tenant("uni-child".into(), Some(parent.id), None).await.unwrap();

    // Set child to Open
    if let coord_store::Store::Memory(m) = state.store().as_ref() {
        let mut tenants = m.tenants_for_test().lock().unwrap();
        tenants.get_mut(&child.id).unwrap().federation_posture =
            coord_core::FederationPosture::Open;
    }

    register_node_for(&state, parent.id, [240u8; 32], 241, "parent-uni").await;
    register_node_for(&state, child.id, [250u8; 32], 251, "child-uni").await;

    // Child node maps — should NOT see parent node (hierarchy is parent→child only)
    let map_body = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([251u8; 32])),
    });
    let result = coord_api::__test_handle_map(&state, &[250u8; 32], &map_body.to_string())
        .await
        .unwrap();
    let resp: serde_json::Value = serde_json::from_str(&result).unwrap();
    assert!(
        resp["Peers"].is_null(),
        "child should NOT see parent peers — route aggregation is parent→child only"
    );
}

#[tokio::test]
async fn hierarchy_selective_posture_allows_visibility() {
    let (_, state) = setup();

    let parent = state.store().create_tenant("sel-parent".into(), None, None).await.unwrap();
    let child = state.store().create_tenant("sel-child".into(), Some(parent.id), None).await.unwrap();

    // Set child to Selective
    if let coord_store::Store::Memory(m) = state.store().as_ref() {
        let mut tenants = m.tenants_for_test().lock().unwrap();
        tenants.get_mut(&child.id).unwrap().federation_posture =
            coord_core::FederationPosture::Selective;
    }

    register_node_for(&state, parent.id, [41u8; 32], 42, "parent-sel").await;
    register_node_for(&state, child.id, [43u8; 32], 44, "child-sel").await;

    let map_body = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([42u8; 32])),
    });
    let result = coord_api::__test_handle_map(&state, &[41u8; 32], &map_body.to_string())
        .await
        .unwrap();
    let resp: serde_json::Value = serde_json::from_str(&result).unwrap();
    let peers = resp["Peers"].as_array().unwrap();
    assert_eq!(peers.len(), 1, "selective posture should allow parent to see child");
    assert_eq!(peers[0]["Name"], "child-sel.mesh.local.");
}

#[tokio::test]
async fn hierarchy_routes_endpoint() {
    let (app, state) = setup();

    let parent = state.store().create_tenant("route-parent".into(), None, None).await.unwrap();
    let child = state.store().create_tenant("route-child".into(), Some(parent.id), None).await.unwrap();

    // Set child to Open
    if let coord_store::Store::Memory(m) = state.store().as_ref() {
        let mut tenants = m.tenants_for_test().lock().unwrap();
        tenants.get_mut(&child.id).unwrap().federation_posture =
            coord_core::FederationPosture::Open;
    }

    register_node_for(&state, parent.id, [31u8; 32], 32, "rp-node").await;
    register_node_for(&state, child.id, [33u8; 32], 34, "rc-node").await;

    let resp = app.clone().oneshot(
        admin_req()
            .uri(format!("/api/tenants/{}/routes", parent.id))
            .body(Body::empty())
            .unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    assert!(!body["own_routes"].as_array().unwrap().is_empty());
    let agg = body["aggregated_child_routes"].as_array().unwrap();
    assert_eq!(agg.len(), 1);
    assert_eq!(agg[0]["slug"], "route-child");
    assert!(agg[0]["node_count"].as_u64().unwrap() >= 1);
}

#[tokio::test]
async fn update_posture_via_api() {
    let (app, state) = setup();
    let tenant = state.store().create_tenant("posture-test".into(), None, None).await.unwrap();

    // Default posture should be Closed
    assert_eq!(tenant.federation_posture, coord_core::FederationPosture::Closed);

    // Update to Open via API
    let resp = app.clone().oneshot(
        admin_req()
            .method("PUT")
            .uri(format!("/api/tenants/{}/posture", tenant.id))
            .header("content-type", "application/json")
            .body(Body::from(r#"{"posture":"open"}"#))
            .unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    assert_eq!(body["federation_posture"], "open");

    // Verify in store
    let updated = state.store().get_tenant(tenant.id).await.unwrap();
    assert_eq!(updated.federation_posture, coord_core::FederationPosture::Open);

    // Update to Selective
    let resp = app.clone().oneshot(
        admin_req()
            .method("PUT")
            .uri(format!("/api/tenants/{}/posture", tenant.id))
            .header("content-type", "application/json")
            .body(Body::from(r#"{"posture":"selective"}"#))
            .unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    assert_eq!(body["federation_posture"], "selective");

    // Invalid posture rejected
    let resp = app.clone().oneshot(
        admin_req()
            .method("PUT")
            .uri(format!("/api/tenants/{}/posture", tenant.id))
            .header("content-type", "application/json")
            .body(Body::from(r#"{"posture":"invalid"}"#))
            .unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

// ── Cross-tenant node operation guard tests ──

#[tokio::test]
async fn delete_node_with_wrong_tenant_returns_403() {
    let (app, state) = setup();

    // Create two tenants
    let tenant_a = create_test_tenant(&state, "guard-tenant-a").await;
    let tenant_b = create_test_tenant(&state, "guard-tenant-b").await;

    // Register a node in tenant A
    register_node_for(&state, tenant_a, [201u8; 32], 202, "tenant-a-node").await;
    let node_a_id = state.store().get_node_by_machine_key(&[201u8; 32]).await.unwrap();

    // Register a node in tenant B
    register_node_for(&state, tenant_b, [203u8; 32], 204, "tenant-b-node").await;

    // Try to delete tenant A's node with tenant_id=B -- should get 403
    let resp = app.clone().oneshot(
        admin_req()
            .method("DELETE")
            .uri(format!("/api/nodes/{}?tenant_id={}", node_a_id.as_i64(), tenant_b))
            .body(Body::empty())
            .unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    let body = json_body(resp).await;
    assert!(body["error"].as_str().unwrap().contains("does not belong"));

    // Verify the node still exists
    let resp = app.clone().oneshot(
        admin_req()
            .uri(format!("/api/nodes/{}", node_a_id.as_i64()))
            .body(Body::empty())
            .unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // Delete tenant A's node with correct tenant_id=A -- should succeed
    let resp = app.clone().oneshot(
        admin_req()
            .method("DELETE")
            .uri(format!("/api/nodes/{}?tenant_id={}", node_a_id.as_i64(), tenant_a))
            .body(Body::empty())
            .unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    assert_eq!(body["status"], "deleted");

    // Verify the node is gone
    let resp = app.clone().oneshot(
        admin_req()
            .uri(format!("/api/nodes/{}", node_a_id.as_i64()))
            .body(Body::empty())
            .unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn rename_node_with_wrong_tenant_returns_403() {
    let (app, state) = setup();

    let tenant_a = create_test_tenant(&state, "rename-guard-a").await;
    let tenant_b = create_test_tenant(&state, "rename-guard-b").await;

    register_node_for(&state, tenant_a, [205u8; 32], 206, "rename-guard-node").await;
    let node_id = state.store().get_node_by_machine_key(&[205u8; 32]).await.unwrap();

    // Try to rename with wrong tenant -- should get 403
    let resp = app.clone().oneshot(
        admin_req()
            .method("POST")
            .uri(format!("/api/nodes/{}/name?tenant_id={}", node_id.as_i64(), tenant_b))
            .header("content-type", "application/json")
            .body(Body::from(r#"{"name":"hijacked"}"#))
            .unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);

    // Verify name unchanged
    let resp = app.clone().oneshot(
        admin_req()
            .uri(format!("/api/nodes/{}", node_id.as_i64()))
            .body(Body::empty())
            .unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    assert_eq!(body["hostname"], "rename-guard-node");

    // Rename with correct tenant -- should succeed
    let resp = app.clone().oneshot(
        admin_req()
            .method("POST")
            .uri(format!("/api/nodes/{}/name?tenant_id={}", node_id.as_i64(), tenant_a))
            .header("content-type", "application/json")
            .body(Body::from(r#"{"name":"properly-renamed"}"#))
            .unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    assert_eq!(body["hostname"], "properly-renamed");
}

// ── Federation message route tests ──

async fn register_collective_did(state: &Arc<CoordinatorState>, slug: &str, did: &str) -> coord_core::TenantId {
    let tenant = state.store().create_tenant(slug.into(), None, None).await.unwrap();
    let cdid = coord_core::types::CollectiveDid {
        tenant_id: tenant.id,
        did: did.to_string(),
        public_key_jwk: serde_json::json!({"kty": "OKP", "crv": "Ed25519"}),
        encrypted_private_key: "encrypted-test-key".to_string(),
        created_at: chrono::Utc::now(),
    };
    state.federation_inbound().store().create_collective_did(cdid).await.unwrap();
    tenant.id
}

#[tokio::test]
async fn federation_hello_missing_recipient_header() {
    let (app, _) = setup();
    let hello = serde_json::json!({
        "collectiveDid": "did:web:example.com:collective:remote",
        "federationType": "peer",
        "offeredCidrs": ["100.64.1.0/24"],
        "capabilities": [],
        "protocolVersion": "1.0",
        "signature": "sig",
        "timestamp": chrono::Utc::now().to_rfc3339()
    });

    let resp = app.oneshot(
        Request::builder()
            .method("POST")
            .uri("/api/federation/messages/hello")
            .header("content-type", "application/json")
            .body(Body::from(hello.to_string()))
            .unwrap(),
    ).await.unwrap();

    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let body = json_body(resp).await;
    assert!(body["error"].as_str().unwrap().contains("CFP-Recipient"));
}

#[tokio::test]
async fn federation_hello_unknown_recipient() {
    let (app, _) = setup();
    let hello = serde_json::json!({
        "collectiveDid": "did:web:example.com:collective:remote",
        "federationType": "peer",
        "offeredCidrs": ["100.64.1.0/24"],
        "capabilities": [],
        "protocolVersion": "1.0",
        "signature": "sig",
        "timestamp": chrono::Utc::now().to_rfc3339()
    });

    let resp = app.oneshot(
        Request::builder()
            .method("POST")
            .uri("/api/federation/messages/hello")
            .header("content-type", "application/json")
            .header("CFP-Recipient", "did:web:nonexistent.com:collective:gone")
            .body(Body::from(hello.to_string()))
            .unwrap(),
    ).await.unwrap();

    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    let body = json_body(resp).await;
    assert!(body["error"].as_str().unwrap().contains("Unknown recipient"));
}

#[tokio::test]
async fn federation_hello_valid_returns_challenge() {
    let (app, state) = setup_with_callbacks();
    let local_did = "did:web:local.mesh:collective:alpha";
    let remote_did = "did:web:remote.mesh:collective:beta";
    let tenant_id = register_collective_did(&state, "fed-hello", local_did).await;

    // Create an active link so the hello is accepted
    use coord_core::types::{FederationLink, LinkId, LinkDirection, LinkStatus};
    let link = FederationLink {
        id: LinkId::generate(),
        local_tenant_id: tenant_id,
        peer_did: remote_did.to_string(),
        peer_broker_url: Some("https://93.184.216.34/broker".to_string()),
        peer_name: Some("Remote Beta".to_string()),
        direction: LinkDirection::Incoming,
        status: LinkStatus::Active,
        local_cidrs: vec!["100.64.0.0/24".to_string()],
        peer_cidrs: vec!["100.64.1.0/24".to_string()],
        protocol_version: Some("1.0".to_string()),
        message: None,
        signed_request: None,
        created_at: chrono::Utc::now(),
        updated_at: chrono::Utc::now(),
    };
    state.federation_inbound().store().create_link(link).await.unwrap();

    let hello = serde_json::json!({
        "collectiveDid": remote_did,
        "federationType": "peer",
        "offeredCidrs": ["100.64.1.0/24"],
        "capabilities": [],
        "protocolVersion": "1.0",
        "signature": "sig",
        "timestamp": chrono::Utc::now().to_rfc3339()
    });

    let resp = app.oneshot(
        Request::builder()
            .method("POST")
            .uri("/api/federation/messages/hello")
            .header("content-type", "application/json")
            .header("CFP-Recipient", local_did)
            .body(Body::from(hello.to_string()))
            .unwrap(),
    ).await.unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    assert_eq!(body["collectiveDid"], local_did);
    assert!(body["nonce"].as_str().is_some());
    assert!(body["signature"].as_str().is_some());
}

#[tokio::test]
async fn federation_link_request_creates_pending() {
    let (app, state) = setup();
    let local_did = "did:web:local.mesh:collective:link-test";
    let remote_did = "did:web:remote.mesh:collective:link-src";
    register_collective_did(&state, "fed-link-req", local_did).await;

    let link_req = serde_json::json!({
        "messageId": uuid::Uuid::new_v4().to_string(),
        "collectiveDid": remote_did,
        "brokerUrl": "https://93.184.216.34/broker",
        "collectiveName": "Remote Source",
        "federationType": "peer",
        "offeredCidrs": ["100.64.2.0/24"],
        "capabilities": [],
        "signature": "sig",
        "timestamp": chrono::Utc::now().to_rfc3339()
    });

    let resp = app.clone().oneshot(
        Request::builder()
            .method("POST")
            .uri("/api/federation/messages/link-request")
            .header("content-type", "application/json")
            .header("CFP-Recipient", local_did)
            .body(Body::from(link_req.to_string()))
            .unwrap(),
    ).await.unwrap();

    assert_eq!(resp.status(), StatusCode::CREATED);
    let body = json_body(resp).await;
    assert_eq!(body["status"], "queued");
}

#[tokio::test]
async fn federation_link_request_rejects_when_active_link_exists() {
    let (app, state) = setup();
    let local_did = "did:web:local.mesh:collective:dup-test";
    let remote_did = "did:web:remote.mesh:collective:dup-src";
    let tenant_id = register_collective_did(&state, "fed-link-dup", local_did).await;

    // Pre-create an active link with the remote peer
    use coord_core::types::{FederationLink, LinkId, LinkDirection, LinkStatus};
    let link = FederationLink {
        id: LinkId::generate(),
        local_tenant_id: tenant_id,
        peer_did: remote_did.to_string(),
        peer_broker_url: Some("https://93.184.216.34/broker".to_string()),
        peer_name: Some("Remote Dup".to_string()),
        direction: LinkDirection::Incoming,
        status: LinkStatus::Active,
        local_cidrs: vec!["100.64.3.0/24".to_string()],
        peer_cidrs: vec!["100.64.3.0/24".to_string()],
        protocol_version: Some("1.0".to_string()),
        message: None,
        signed_request: None,
        created_at: chrono::Utc::now(),
        updated_at: chrono::Utc::now(),
    };
    state.federation_inbound().store().create_link(link).await.unwrap();

    // New link request from same peer should be rejected (active link already exists)
    let link_req = serde_json::json!({
        "messageId": uuid::Uuid::new_v4().to_string(),
        "collectiveDid": remote_did,
        "brokerUrl": "https://93.184.216.34/broker",
        "collectiveName": "Remote Dup Again",
        "federationType": "peer",
        "offeredCidrs": ["100.64.3.0/24"],
        "capabilities": [],
        "signature": "sig",
        "timestamp": chrono::Utc::now().to_rfc3339()
    });

    let resp = app.clone().oneshot(
        Request::builder()
            .method("POST")
            .uri("/api/federation/messages/link-request")
            .header("content-type", "application/json")
            .header("CFP-Recipient", local_did)
            .body(Body::from(link_req.to_string()))
            .unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn federation_keepalive_missing_session_rejected() {
    let (app, state) = setup();
    let local_did = "did:web:local.mesh:collective:ka-test";
    register_collective_did(&state, "fed-ka-test", local_did).await;

    let keepalive = serde_json::json!({
        "sessionId": uuid::Uuid::new_v4().to_string(),
        "sequenceNumber": 1,
        "timestamp": chrono::Utc::now().to_rfc3339()
    });

    let resp = app.oneshot(
        Request::builder()
            .method("POST")
            .uri("/api/federation/messages/keepalive")
            .header("content-type", "application/json")
            .header("CFP-Recipient", local_did)
            .body(Body::from(keepalive.to_string()))
            .unwrap(),
    ).await.unwrap();

    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn federation_revoke_missing_session_rejected() {
    let (app, state) = setup();
    let local_did = "did:web:local.mesh:collective:rev-test";
    register_collective_did(&state, "fed-rev-test", local_did).await;

    let revoke = serde_json::json!({
        "sessionId": uuid::Uuid::new_v4().to_string(),
        "permanent": false,
        "signature": "sig",
        "timestamp": chrono::Utc::now().to_rfc3339()
    });

    let resp = app.oneshot(
        Request::builder()
            .method("POST")
            .uri("/api/federation/messages/revoke")
            .header("content-type", "application/json")
            .header("CFP-Recipient", local_did)
            .body(Body::from(revoke.to_string()))
            .unwrap(),
    ).await.unwrap();

    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

// ── Admin auth middleware tests ───────────────────────────────────────────────

fn setup_with_admin_key() -> (axum::Router, Arc<CoordinatorState>) {
    let key = coord_noise::generate_control_key();
    let state = Arc::new(
        CoordinatorState::new(key)
            .with_admin_api_key(Some("test-admin-secret".to_string())),
    );
    let app = coord_api::router(state.clone());
    (app, state)
}

#[tokio::test]
async fn admin_api_rejects_missing_auth() {
    let (app, _) = setup_with_admin_key();
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/nodes")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn admin_api_rejects_wrong_key() {
    let (app, _) = setup_with_admin_key();
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/nodes")
                .header("authorization", "Bearer wrong-key")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn admin_api_accepts_correct_key() {
    let (app, _) = setup_with_admin_key();
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/nodes")
                .header("authorization", "Bearer test-admin-secret")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn admin_api_rejects_when_no_key_configured() {
    let key = coord_noise::generate_control_key();
    let state = Arc::new(CoordinatorState::new(key));
    let app = coord_api::router(state);
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/nodes")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn health_endpoint_bypasses_admin_auth() {
    let (app, _) = setup_with_admin_key();
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn admin_create_tenant_with_federation_posture() {
    let (app, _) = setup();

    let resp = app.clone()
        .oneshot(
            admin_req()
                .method("POST")
                .uri("/api/tenants")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"slug":"fp-sel","federation_posture":"selective"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);
    let body: serde_json::Value = serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body["federation_posture"], "selective");

    let resp = app.clone()
        .oneshot(
            admin_req()
                .method("POST")
                .uri("/api/tenants")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"slug":"fp-open","federation_posture":"open"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);
    let body: serde_json::Value = serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body["federation_posture"], "open");

    let resp = app
        .oneshot(
            admin_req()
                .method("POST")
                .uri("/api/tenants")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"slug":"fp-default"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);
    let body: serde_json::Value = serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body["federation_posture"], "closed");
}

#[tokio::test]
async fn admin_create_tenant_rejects_invalid_posture() {
    let (app, _) = setup();

    let resp = app
        .oneshot(
            admin_req()
                .method("POST")
                .uri("/api/tenants")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"slug":"fp-bad","federation_posture":"aggressive"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn admin_delete_nonexistent_tenant_returns_404() {
    let (app, _) = setup();

    let resp = app
        .oneshot(
            admin_req()
                .method("DELETE")
                .uri("/api/tenants/00000000-0000-0000-0000-000000000000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn admin_delete_nonexistent_node_returns_404() {
    let (app, _) = setup();

    let resp = app
        .oneshot(
            admin_req()
                .method("DELETE")
                .uri("/api/nodes/999999")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn admin_rename_nonexistent_node_returns_404() {
    let (app, _) = setup();

    let resp = app
        .oneshot(
            admin_req()
                .method("POST")
                .uri("/api/nodes/999999/name")
                .header("Content-Type", "application/json")
                .body(Body::from(r#"{"name":"new-host"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn federation_hello_missing_header_returns_400() {
    let (app, _) = setup_with_callbacks();

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/federation/messages/hello")
                .header("Content-Type", "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn create_tenant_with_nonexistent_parent_returns_404() {
    let (app, _) = setup();

    let resp = app
        .oneshot(
            admin_req()
                .method("POST")
                .uri("/api/tenants")
                .header("Content-Type", "application/json")
                .body(Body::from(
                    r#"{"slug":"orphan","parent_id":"00000000-0000-0000-0000-000000000000"}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn create_tenant_multi_level_hierarchy_rejected() {
    let (app, state) = setup();

    let parent = state.store().create_tenant("parent".into(), None, None).await.unwrap();
    let child = state.store().create_tenant("child".into(), Some(parent.id), None).await.unwrap();

    let resp = app
        .oneshot(
            admin_req()
                .method("POST")
                .uri("/api/tenants")
                .header("Content-Type", "application/json")
                .body(Body::from(format!(
                    r#"{{"slug":"grandchild","parent_id":"{}"}}"#,
                    child.id
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn federation_commit_missing_header_returns_400() {
    let (app, _) = setup_with_callbacks();

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/federation/messages/commit")
                .header("Content-Type", "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

// ── Per-tenant DERP ──

async fn register_and_map(
    state: &Arc<CoordinatorState>,
    tenant_id: coord_core::TenantId,
    seed: u8,
) -> serde_json::Value {
    let auth_key = state.store().create_preauth_key(tenant_id, false).await.unwrap();
    let machine_key = [seed; 32];
    let node_key = format!("nodekey:{}", hex::encode([seed.wrapping_add(1); 32]));
    let reg = serde_json::json!({
        "Version": 2,
        "NodeKey": &node_key,
        "Auth": { "AuthKey": &auth_key },
        "Hostinfo": { "Hostname": format!("n{seed}"), "OS": "linux" }
    });
    coord_api::__test_handle_register(state, &machine_key, &reg.to_string()).await.unwrap();
    let map = serde_json::json!({ "Version": 2, "NodeKey": &node_key });
    let out = coord_api::__test_handle_map(state, &machine_key, &map.to_string()).await.unwrap();
    serde_json::from_str(&out).unwrap()
}

fn put_tenant_derp(tenant_id: coord_core::TenantId, body: serde_json::Value) -> Request<Body> {
    Request::builder()
        .method("PUT")
        .uri(format!("/api/tenants/{tenant_id}/derp"))
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {TEST_ADMIN_KEY}"))
        .body(Body::from(body.to_string()))
        .unwrap()
}

#[tokio::test]
async fn tenant_derp_override_is_isolated() {
    let (app, state) = setup_with_relay_region();
    let a = create_test_tenant(&state, "derp-a").await;
    let b = create_test_tenant(&state, "derp-b").await;

    let resp = app
        .oneshot(put_tenant_derp(a, serde_json::json!({
            "include_default": false,
            "regions": { "901": {
                "RegionID": 901, "RegionCode": "own", "RegionName": "Own",
                "Nodes": [{ "Name": "901a", "RegionID": 0, "HostName": "derp.a.example",
                            "STUNPort": 3478, "DERPPort": 443, "InsecureForTests": true }]
            }}
        })))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let map_a = register_and_map(&state, a, 160).await;
    let regions_a = map_a["DERPMap"]["Regions"].as_object().unwrap();
    assert_eq!(regions_a.keys().collect::<Vec<_>>(), vec!["901"]);
    assert_eq!(regions_a["901"]["Nodes"][0]["RegionID"], 901);
    assert!(regions_a["901"]["Nodes"][0].get("InsecureForTests").is_none());
    assert_eq!(map_a["Node"]["HomeDERP"], 901);

    let map_b = register_and_map(&state, b, 170).await;
    let regions_b = map_b["DERPMap"]["Regions"].as_object().unwrap();
    assert!(!regions_b.contains_key("901"), "tenant B must not see tenant A's DERP region");
    assert!(regions_b.contains_key("1"));
}

#[tokio::test]
async fn tenant_derp_include_default_merges() {
    let (app, state) = setup_with_relay_region();
    let t = create_test_tenant(&state, "derp-merge").await;
    let resp = app
        .oneshot(put_tenant_derp(t, serde_json::json!({
            "include_default": true,
            "regions": { "950": {
                "RegionID": 950, "RegionCode": "x", "RegionName": "X",
                "Nodes": [{ "Name": "950a", "RegionID": 950, "HostName": "derp.x.example",
                            "STUNPort": 3478, "DERPPort": 443 }]
            }}
        })))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let map = register_and_map(&state, t, 180).await;
    let regions = map["DERPMap"]["Regions"].as_object().unwrap();
    assert!(regions.contains_key("1") && regions.contains_key("950"));
}

#[tokio::test]
async fn tenant_derp_validation() {
    let (app, state) = setup();
    let t = create_test_tenant(&state, "derp-bad").await;
    let region = |id: i32, host: &str| serde_json::json!({
        "RegionID": id, "RegionCode": "r", "RegionName": "R",
        "Nodes": [{ "Name": "n", "RegionID": id, "HostName": host, "STUNPort": 3478, "DERPPort": 443 }]
    });
    let cases = [
        serde_json::json!({ "include_default": false, "regions": {} }),
        serde_json::json!({ "include_default": true, "regions": { "1": region(1, "derp.example") } }),
        serde_json::json!({ "include_default": true, "regions": { "902": region(903, "derp.example") } }),
        serde_json::json!({ "include_default": true, "regions": { "904": region(904, "bad host/../x") } }),
    ];
    for body in cases {
        let resp = app.clone().oneshot(put_tenant_derp(t, body.clone())).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "expected 400 for {body}");
    }
    let missing = coord_core::TenantId::new(uuid::Uuid::new_v4());
    let resp = app
        .oneshot(put_tenant_derp(missing, serde_json::json!({ "include_default": true })))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn known_machine_reregisters_without_auth_key() {
    let (_, state) = setup();
    let t = create_test_tenant(&state, "rereg").await;
    register_and_map(&state, t, 190).await;

    let node_key = format!("nodekey:{}", hex::encode([191u8; 32]));
    let same = serde_json::json!({ "Version": 2, "NodeKey": &node_key });
    let out = coord_api::__test_handle_register(&state, &[190u8; 32], &same.to_string()).await.unwrap();
    let resp: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(resp["MachineAuthorized"], true, "restart re-register must not need an auth key: {resp}");
    assert_eq!(resp["AuthURL"], "");

    let stranger = serde_json::json!({ "Version": 2, "NodeKey": format!("nodekey:{}", hex::encode([9u8; 32])) });
    let out = coord_api::__test_handle_register(&state, &[8u8; 32], &stranger.to_string()).await.unwrap();
    let resp: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_ne!(resp["MachineAuthorized"], true, "unknown machine without auth key must not be authorized");
}

// ── Pre-auth key lifecycle, ownership, routes, ephemeral (contract §A) ──

async fn api_call(
    app: &axum::Router,
    method: &str,
    uri: String,
    body: Option<serde_json::Value>,
) -> (StatusCode, serde_json::Value) {
    let mut req = admin_req().method(method).uri(uri);
    let body = match body {
        Some(b) => {
            req = req.header("content-type", "application/json");
            Body::from(b.to_string())
        }
        None => Body::empty(),
    };
    let resp = app.clone().oneshot(req.body(body).unwrap()).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json = if bytes.is_empty() { serde_json::Value::Null } else { serde_json::from_slice(&bytes).unwrap() };
    (status, json)
}

async fn api_key(app: &axum::Router, body: serde_json::Value) -> serde_json::Value {
    let (status, json) = api_call(app, "POST", "/api/preauth-keys".into(), Some(body)).await;
    assert_eq!(status, StatusCode::CREATED, "{json}");
    json
}

/// Register `mkey` with `auth_key`, advertising `routes` (None = no RoutableIPs).
async fn register_routes(
    state: &Arc<CoordinatorState>,
    mkey: u8,
    auth_key: &str,
    hostname: &str,
    routes: Option<&[&str]>,
) -> serde_json::Value {
    let mut hostinfo = serde_json::json!({ "Hostname": hostname, "OS": "linux" });
    if let Some(r) = routes {
        hostinfo["RoutableIPs"] = serde_json::json!(r);
    }
    let body = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([mkey.wrapping_add(1); 32])),
        "Auth": { "AuthKey": auth_key },
        "Hostinfo": hostinfo,
    });
    let out = coord_api::__test_handle_register(state, &[mkey; 32], &body.to_string()).await.unwrap();
    serde_json::from_str(&out).unwrap()
}

async fn map_of(state: &Arc<CoordinatorState>, mkey: u8, hostinfo: Option<serde_json::Value>) -> serde_json::Value {
    let mut body = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([mkey.wrapping_add(1); 32])),
    });
    if let Some(h) = hostinfo {
        body["Hostinfo"] = h;
    }
    let out = coord_api::__test_handle_map(state, &[mkey; 32], &body.to_string()).await.unwrap();
    serde_json::from_str(&out).unwrap()
}

async fn node_id_of(state: &Arc<CoordinatorState>, mkey: u8) -> i64 {
    state.store().get_node_by_machine_key(&[mkey; 32]).await.unwrap().as_i64()
}

type MapBody = http_body_util::combinators::BoxBody<bytes::Bytes, std::io::Error>;

/// Next decoded map frame; `None` once the stream has ended. Panics on timeout.
async fn next_map_frame(body: &mut MapBody) -> Option<serde_json::Value> {
    let frame = tokio::time::timeout(std::time::Duration::from_secs(3), body.frame())
        .await
        .expect("timed out waiting for map frame")?;
    let data = frame.unwrap().into_data().unwrap();
    let len = u32::from_le_bytes(data[..4].try_into().unwrap()) as usize;
    let json = zstd::bulk::decompress(&data[4..4 + len], 1 << 20).unwrap();
    Some(serde_json::from_slice(&json).unwrap())
}

async fn open_stream(state: &Arc<CoordinatorState>, mkey: u8) -> MapBody {
    let body = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([mkey.wrapping_add(1); 32])),
        "Stream": true,
    });
    let resp = coord_api::__test_map_request(state.clone(), [mkey; 32], &body.to_string()).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let mut body = resp.into_body();
    let first = next_map_frame(&mut body).await.expect("initial snapshot");
    assert!(first["Node"].is_object());
    body
}

#[tokio::test]
async fn preauth_key_create_validates_and_reports_expiry() {
    let (app, state) = setup();
    let t = create_test_tenant(&state, "key-create").await;

    let k = api_key(&app, serde_json::json!({
        "tenant_id": t.to_string(), "expiration_seconds": 3600,
        "owner": "user-1", "tags": ["tag:relay"], "ephemeral": true,
    })).await;
    assert!(k["key"].as_str().unwrap().starts_with("tskey-auth-"));
    assert!(uuid::Uuid::parse_str(k["id"].as_str().unwrap()).is_ok());
    assert_eq!(k["tenant_id"], t.to_string());
    let exp = chrono::DateTime::parse_from_rfc3339(k["expires_at"].as_str().unwrap()).unwrap();
    let delta = exp.timestamp() - chrono::Utc::now().timestamp();
    assert!((3590..=3601).contains(&delta), "expires_at off: {delta}");

    let k = api_key(&app, serde_json::json!({ "tenant_id": t.to_string() })).await;
    assert!(k["expires_at"].is_null(), "no expiration_seconds = never expires");

    for bad in [
        serde_json::json!({ "tenant_id": t.to_string(), "expiration_seconds": 0 }),
        serde_json::json!({ "tenant_id": t.to_string(), "expiration_seconds": 31536001u64 }),
        serde_json::json!({ "tenant_id": t.to_string(), "tags": ["relay"] }),
        serde_json::json!({ "tenant_id": t.to_string(), "tags": ["tag:UPPER"] }),
        serde_json::json!({ "tenant_id": t.to_string(), "tags": (0..9).map(|i| format!("tag:t{i}")).collect::<Vec<_>>() }),
        serde_json::json!({ "tenant_id": t.to_string(), "owner": "x".repeat(129) }),
    ] {
        let (status, _) = api_call(&app, "POST", "/api/preauth-keys".into(), Some(bad.clone())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "expected 400 for {bad}");
    }
}

#[tokio::test]
async fn expired_preauth_key_rejected_at_register() {
    let (_, state) = setup();
    let t = create_test_tenant(&state, "key-expired").await;
    let expired = state
        .store()
        .create_preauth_key_with(t, coord_core::PreAuthKeyOptions {
            reusable: true,
            expires_at: chrono::DateTime::from_timestamp(chrono::Utc::now().timestamp() - 1, 0),
            ..Default::default()
        })
        .await
        .unwrap();
    let resp = register_routes(&state, 30, &expired.key, "late", None).await;
    assert_eq!(resp["MachineAuthorized"], false);
    assert!(resp["Error"].as_str().unwrap().contains("expired"));
    assert!(state.store().get_node_by_machine_key(&[30u8; 32]).await.is_none());
}

#[tokio::test]
async fn revoked_reusable_key_rejected() {
    let (app, state) = setup();
    let t = create_test_tenant(&state, "key-revoke").await;
    let other = create_test_tenant(&state, "key-revoke-other").await;
    let k = api_key(&app, serde_json::json!({ "tenant_id": t.to_string(), "reusable": true, "owner": "bob" })).await;
    let key = k["key"].as_str().unwrap();
    let id = k["id"].as_str().unwrap();

    assert_eq!(register_routes(&state, 40, key, "first", None).await["MachineAuthorized"], true);

    // Another tenant can't revoke it; unknown ids are 404.
    let (status, _) = api_call(&app, "DELETE", format!("/api/tenants/{other}/preauth-keys/{id}"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = api_call(&app, "DELETE", format!("/api/tenants/{t}/preauth-keys/{}", uuid::Uuid::new_v4()), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, body) = api_call(&app, "DELETE", format!("/api/tenants/{t}/preauth-keys/{id}"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "revoked");

    let resp = register_routes(&state, 42, key, "second", None).await;
    assert_eq!(resp["MachineAuthorized"], false, "revoked reusable key must be rejected");

    // Bulk revoke by owner.
    for _ in 0..2 {
        api_key(&app, serde_json::json!({ "tenant_id": t.to_string(), "reusable": true, "owner": "carol" })).await;
    }
    let (status, body) = api_call(&app, "DELETE", format!("/api/tenants/{t}/preauth-keys?owner=carol"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["revoked"], 2);
    let (status, _) = api_call(&app, "DELETE", format!("/api/tenants/{t}/preauth-keys"), None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "owner is required for bulk revoke");
}

#[tokio::test]
async fn key_listing_never_exposes_full_key() {
    let (app, state) = setup();
    let t = create_test_tenant(&state, "key-list").await;
    let k = api_key(&app, serde_json::json!({
        "tenant_id": t.to_string(), "owner": "u1", "tags": ["tag:b", "tag:a"], "expiration_seconds": 60,
    })).await;
    let full_key = k["key"].as_str().unwrap().to_string();

    let resp = app.clone().oneshot(
        admin_req().uri(format!("/api/tenants/{t}/preauth-keys")).body(Body::empty()).unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let raw = resp.into_body().collect().await.unwrap().to_bytes();
    let text = String::from_utf8(raw.to_vec()).unwrap();
    assert!(!text.contains(&full_key), "listing leaked the full key: {text}");

    let body: serde_json::Value = serde_json::from_str(&text).unwrap();
    let keys = body["keys"].as_array().unwrap();
    assert_eq!(keys.len(), 1);
    let entry = &keys[0];
    assert_eq!(entry["id"], k["id"]);
    assert_eq!(entry["prefix"], full_key[..12]);
    assert_eq!(entry["owner"], "u1");
    assert_eq!(entry["tags"], serde_json::json!(["tag:a", "tag:b"]));
    assert_eq!(entry["reusable"], false);
    assert_eq!(entry["ephemeral"], false);
    assert_eq!(entry["used"], false);
    assert_eq!(entry["revoked"], false);
    assert_eq!(entry["expires_at"], k["expires_at"]);
    assert!(entry["created_at"].is_string());
    assert!(entry.get("key").is_none());

    let (status, _) = api_call(&app, "GET", format!("/api/tenants/{}/preauth-keys", uuid::Uuid::new_v4()), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn owner_and_tags_propagate_from_key_to_node() {
    let (app, state) = setup();
    let t = create_test_tenant(&state, "owner-prop").await;
    let k = api_key(&app, serde_json::json!({
        "tenant_id": t.to_string(), "owner": "did:plc:alice", "tags": ["tag:relay"], "ephemeral": true, "reusable": true,
    })).await;
    register_routes(&state, 50, k["key"].as_str().unwrap(), "alice-laptop", None).await;
    let nid = node_id_of(&state, 50).await;

    let check = |n: &serde_json::Value| {
        assert_eq!(n["owner"], "did:plc:alice", "{n}");
        assert_eq!(n["tags"], serde_json::json!(["tag:relay"]), "{n}");
        assert_eq!(n["ephemeral"], true, "{n}");
        assert_eq!(n["advertised_routes"], serde_json::json!([]), "{n}");
        assert_eq!(n["approved_routes"], serde_json::json!([]), "{n}");
    };
    let (_, body) = api_call(&app, "GET", format!("/api/tenants/{t}/nodes"), None).await;
    check(&body["nodes"][0]);
    let (_, body) = api_call(&app, "GET", "/api/nodes".into(), None).await;
    check(&body["nodes"][0]);
    let (_, body) = api_call(&app, "GET", format!("/api/nodes/{nid}"), None).await;
    check(&body);
    let (_, body) = api_call(&app, "POST", format!("/api/nodes/{nid}/name"), Some(serde_json::json!({"name": "renamed"}))).await;
    check(&body);

    // A key-less node has no owner.
    let plain = state.store().create_preauth_key(t, false).await.unwrap();
    register_routes(&state, 52, &plain, "plain", None).await;
    let (_, body) = api_call(&app, "GET", format!("/api/nodes/{}", node_id_of(&state, 52).await), None).await;
    assert!(body["owner"].is_null());
    assert_eq!(body["ephemeral"], false);
}

#[tokio::test]
async fn delete_nodes_by_owner_ends_their_streams() {
    let (app, state) = setup();
    let t = create_test_tenant(&state, "owner-del").await;
    let bob = api_key(&app, serde_json::json!({ "tenant_id": t.to_string(), "owner": "bob", "reusable": true })).await;
    let carol = api_key(&app, serde_json::json!({ "tenant_id": t.to_string(), "owner": "carol" })).await;
    register_routes(&state, 60, bob["key"].as_str().unwrap(), "bob-1", None).await;
    register_routes(&state, 62, bob["key"].as_str().unwrap(), "bob-2", None).await;
    register_routes(&state, 64, carol["key"].as_str().unwrap(), "carol-1", None).await;
    let bob1 = node_id_of(&state, 60).await;

    let mut bob_stream = open_stream(&state, 60).await;
    let mut carol_stream = open_stream(&state, 64).await;

    let (status, body) = api_call(&app, "DELETE", format!("/api/tenants/{t}/nodes?owner=bob"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["deleted"], 2);

    // Bob's stream ends promptly.
    let mut ended = false;
    for _ in 0..5 {
        if next_map_frame(&mut bob_stream).await.is_none() {
            ended = true;
            break;
        }
    }
    assert!(ended, "deleted node's map stream must end");

    // Carol sees both of Bob's nodes removed.
    let mut removed = Vec::new();
    while removed.len() < 2 {
        let frame = next_map_frame(&mut carol_stream).await.expect("carol stream still open");
        if let Some(ids) = frame["PeersRemoved"].as_array() {
            removed.extend(ids.iter().map(|v| v.as_i64().unwrap()));
        }
    }
    assert!(removed.contains(&bob1));

    let (_, body) = api_call(&app, "GET", format!("/api/tenants/{t}/nodes"), None).await;
    assert_eq!(body["count"], 1);
    assert_eq!(body["nodes"][0]["owner"], "carol");

    let (status, _) = api_call(&app, "DELETE", format!("/api/tenants/{t}/nodes"), None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "owner is required; never delete every node");
}

#[tokio::test]
async fn route_advertisement_and_approval_reach_peers() {
    let (app, state) = setup();
    let t = create_test_tenant(&state, "routes").await;
    let key = state.store().create_preauth_key(t, true).await.unwrap();
    register_routes(&state, 70, &key, "router", Some(&["10.0.0.9/24", "0.0.0.0/0", "bogus"])).await;
    register_routes(&state, 72, &key, "laptop", None).await;
    let router = node_id_of(&state, 70).await;

    let (_, node) = api_call(&app, "GET", format!("/api/nodes/{router}"), None).await;
    assert_eq!(node["advertised_routes"], serde_json::json!(["0.0.0.0/0", "10.0.0.0/24"]));
    assert_eq!(node["approved_routes"], serde_json::json!([]));

    // Unapproved routes are not served.
    let m = map_of(&state, 72, None).await;
    assert_eq!(m["Peers"][0]["AllowedIPs"].as_array().unwrap().len(), 1);
    assert!(m["Peers"][0].get("PrimaryRoutes").is_none());

    let mut router_stream = open_stream(&state, 70).await;
    let (status, node) = api_call(
        &app, "POST", format!("/api/tenants/{t}/nodes/{router}/routes"),
        Some(serde_json::json!({ "approved": ["10.0.0.0/24", "0.0.0.0/0"] })),
    ).await;
    assert_eq!(status, StatusCode::OK, "{node}");
    assert_eq!(node["approved_routes"], serde_json::json!(["0.0.0.0/0", "10.0.0.0/24"]));
    assert_eq!(node["id"], router);

    let m = map_of(&state, 72, None).await;
    let peer = &m["Peers"][0];
    let ip = format!("{}/32", node["ipv4"].as_str().unwrap());
    assert_eq!(peer["Addresses"], serde_json::json!([ip]));
    assert_eq!(peer["AllowedIPs"], serde_json::json!([ip, "0.0.0.0/0", "10.0.0.0/24"]));
    assert_eq!(peer["PrimaryRoutes"], serde_json::json!(["10.0.0.0/24"]));

    // The router's own netmap reflects it, and its live stream got a fresh snapshot.
    let me = map_of(&state, 70, None).await;
    assert_eq!(me["Node"]["PrimaryRoutes"], serde_json::json!(["10.0.0.0/24"]));
    let mut saw = false;
    for _ in 0..5 {
        let f = next_map_frame(&mut router_stream).await.expect("stream open");
        if f["Node"]["PrimaryRoutes"] == serde_json::json!(["10.0.0.0/24"]) {
            saw = true;
            break;
        }
    }
    assert!(saw, "approval must push a snapshot to the router's own stream");

    // Peer deltas carry routes too.
    let ev = coord_store::PeerEvent::NodeUpdated { tenant_id: t, node_id: coord_core::NodeId::new(router) };
    let delta: serde_json::Value =
        serde_json::from_str(&coord_api::__test_build_delta(&state, &[72u8; 32], &ev).await.unwrap()).unwrap();
    assert_eq!(delta["PeersChanged"][0]["PrimaryRoutes"], serde_json::json!(["10.0.0.0/24"]));

    // Withdrawing an advertisement (map request Hostinfo) stops serving it.
    map_of(&state, 70, Some(serde_json::json!({ "Hostname": "router", "RoutableIPs": ["0.0.0.0/0"] }))).await;
    let m = map_of(&state, 72, None).await;
    assert_eq!(m["Peers"][0]["AllowedIPs"], serde_json::json!([ip, "0.0.0.0/0"]));
}

#[tokio::test]
async fn approving_unadvertised_route_is_400() {
    let (app, state) = setup();
    let t = create_test_tenant(&state, "routes-bad").await;
    let other = create_test_tenant(&state, "routes-bad-o").await;
    let key = state.store().create_preauth_key(t, true).await.unwrap();
    register_routes(&state, 80, &key, "router", Some(&["10.0.0.0/24"])).await;
    let router = node_id_of(&state, 80).await;
    let uri = format!("/api/tenants/{t}/nodes/{router}/routes");

    let (status, _) = api_call(&app, "POST", uri.clone(), Some(serde_json::json!({ "approved": ["192.168.0.0/24"] }))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = api_call(&app, "POST", uri.clone(), Some(serde_json::json!({ "approved": ["10.0.0.0/16"] }))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "a supernet of an advertised route is not a subset");
    let (status, _) = api_call(&app, "POST", uri.clone(), Some(serde_json::json!({ "approved": ["not-a-cidr"] }))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = api_call(
        &app, "POST", format!("/api/tenants/{other}/nodes/{router}/routes"),
        Some(serde_json::json!({ "approved": ["10.0.0.0/24"] })),
    ).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "node must belong to the tenant in the path");

    let (_, node) = api_call(&app, "GET", format!("/api/nodes/{router}"), None).await;
    assert_eq!(node["approved_routes"], serde_json::json!([]));

    // Approving the empty set clears approvals.
    let (status, _) = api_call(&app, "POST", uri.clone(), Some(serde_json::json!({ "approved": ["10.0.0.0/24"] }))).await;
    assert_eq!(status, StatusCode::OK);
    let (status, node) = api_call(&app, "POST", uri, Some(serde_json::json!({ "approved": [] }))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(node["approved_routes"], serde_json::json!([]));
}

#[tokio::test]
async fn auto_approver_approves_only_tagged_contained_routes() {
    let (app, state) = setup();
    let t = create_test_tenant(&state, "auto-approve").await;
    let uri = format!("/api/tenants/{t}/auto-approvers");

    let (_, empty) = api_call(&app, "GET", uri.clone(), None).await;
    assert_eq!(empty, serde_json::json!({ "routes": {}, "exit_node": [] }));

    let (status, _) = api_call(&app, "PUT", uri.clone(), Some(serde_json::json!({ "routes": { "10.0.0.0/8": ["relay"] } }))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = api_call(&app, "PUT", uri.clone(), Some(serde_json::json!({ "routes": { "10.0.0.0/88": ["tag:relay"] } }))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, cfg) = api_call(&app, "PUT", uri.clone(), Some(serde_json::json!({
        "routes": { "10.0.0.1/8": ["tag:relay"] }, "exit_node": ["tag:exit"],
    }))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cfg, serde_json::json!({ "routes": { "10.0.0.0/8": ["tag:relay"] }, "exit_node": ["tag:exit"] }));
    let (_, got) = api_call(&app, "GET", uri.clone(), None).await;
    assert_eq!(got, cfg);

    let tagged = api_key(&app, serde_json::json!({ "tenant_id": t.to_string(), "tags": ["tag:relay"] })).await;
    let untagged = state.store().create_preauth_key(t, true).await.unwrap();

    register_routes(&state, 90, tagged["key"].as_str().unwrap(), "relay",
        Some(&["10.1.0.0/16", "192.168.0.0/24", "0.0.0.0/0"])).await;
    register_routes(&state, 92, &untagged, "plain", Some(&["10.2.0.0/16"])).await;
    let relay = node_id_of(&state, 90).await;
    let plain = node_id_of(&state, 92).await;

    let (_, n) = api_call(&app, "GET", format!("/api/nodes/{relay}"), None).await;
    assert_eq!(n["approved_routes"], serde_json::json!(["10.1.0.0/16"]), "only the contained route, no exit");
    let (_, n) = api_call(&app, "GET", format!("/api/nodes/{plain}"), None).await;
    assert_eq!(n["approved_routes"], serde_json::json!([]), "untagged nodes are never auto-approved");

    // A node can't grant itself tags via Hostinfo.RequestTags.
    map_of(&state, 92, Some(serde_json::json!({
        "Hostname": "plain", "RoutableIPs": ["10.3.0.0/16"], "RequestTags": ["tag:relay"],
    }))).await;
    let (_, n) = api_call(&app, "GET", format!("/api/nodes/{plain}"), None).await;
    assert_eq!(n["advertised_routes"], serde_json::json!(["10.3.0.0/16"]));
    assert_eq!(n["approved_routes"], serde_json::json!([]));

    // Map-time advertisement of a new contained route is auto-approved.
    map_of(&state, 90, Some(serde_json::json!({
        "Hostname": "relay", "RoutableIPs": ["10.1.0.0/16", "10.9.9.0/24"],
    }))).await;
    let (_, n) = api_call(&app, "GET", format!("/api/nodes/{relay}"), None).await;
    assert_eq!(n["approved_routes"], serde_json::json!(["10.1.0.0/16", "10.9.9.0/24"]));

    // Updating the policy applies to already-registered nodes (exit route now covered).
    map_of(&state, 90, Some(serde_json::json!({ "Hostname": "relay", "RoutableIPs": ["10.1.0.0/16", "::/0"] }))).await;
    let exit_key = api_key(&app, serde_json::json!({ "tenant_id": t.to_string(), "tags": ["tag:exit"] })).await;
    register_routes(&state, 94, exit_key["key"].as_str().unwrap(), "exit", Some(&["0.0.0.0/0", "::/0"])).await;
    let exit = node_id_of(&state, 94).await;
    let (_, n) = api_call(&app, "GET", format!("/api/nodes/{exit}"), None).await;
    assert_eq!(n["approved_routes"], serde_json::json!(["0.0.0.0/0", "::/0"]));

    let (status, _) = api_call(&app, "PUT", uri, Some(serde_json::json!({
        "routes": { "10.0.0.0/8": ["tag:relay"] }, "exit_node": ["tag:exit", "tag:relay"],
    }))).await;
    assert_eq!(status, StatusCode::OK);
    let (_, n) = api_call(&app, "GET", format!("/api/nodes/{relay}"), None).await;
    let approved = n["approved_routes"].as_array().unwrap();
    assert!(approved.contains(&serde_json::json!("::/0")), "{n}");

    // Unknown tenants are 404.
    let (status, _) = api_call(&app, "GET", format!("/api/tenants/{}/auto-approvers", uuid::Uuid::new_v4()), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn ephemeral_nodes_swept_after_offline_grace() {
    let (app, state) = setup();
    let t = create_test_tenant(&state, "ephemeral").await;
    let eph = api_key(&app, serde_json::json!({ "tenant_id": t.to_string(), "ephemeral": true, "reusable": true })).await;
    let durable = state.store().create_preauth_key(t, true).await.unwrap();

    register_routes(&state, 100, eph["key"].as_str().unwrap(), "eph-off", None).await;
    register_routes(&state, 102, eph["key"].as_str().unwrap(), "eph-on", None).await;
    register_routes(&state, 104, &durable, "durable", None).await;
    let off = state.store().get_node_by_machine_key(&[100u8; 32]).await.unwrap();
    let durable_id = state.store().get_node_by_machine_key(&[104u8; 32]).await.unwrap();
    state.store().set_node_online(off, false).await.unwrap();
    state.store().set_node_online(durable_id, false).await.unwrap();

    assert_eq!(coord_api::sweep_ephemeral_nodes(&state, coord_api::EPHEMERAL_OFFLINE_GRACE).await, 0);
    assert_eq!(coord_api::sweep_ephemeral_nodes(&state, std::time::Duration::ZERO).await, 1);
    assert!(state.store().get_node_tenant(off).await.is_none());
    assert!(state.store().get_node_by_machine_key(&[102u8; 32]).await.is_some(), "online ephemeral node kept");
    assert!(state.store().get_node_tenant(durable_id).await.is_some(), "non-ephemeral node kept");
}

#[tokio::test]
async fn federation_routes_absent_when_disabled() {
    let state = Arc::new(
        CoordinatorState::new(coord_noise::generate_control_key()).with_federation_enabled(false),
    );
    let resp = coord_api::router(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/federation/messages/hello")
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

// ── Tenant suspension ──

async fn set_suspended(app: &axum::Router, t: coord_core::TenantId, suspended: bool) -> serde_json::Value {
    let (status, body) = api_call(
        app,
        "PUT",
        format!("/api/tenants/{t}/suspended"),
        Some(serde_json::json!({ "suspended": suspended })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["suspended"], suspended);
    body
}

/// Re-register a known machine with its current node key and no auth key
/// (what tailscaled does on restart).
async fn reregister_known(state: &Arc<CoordinatorState>, mkey: u8) -> serde_json::Value {
    let body = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([mkey.wrapping_add(1); 32])),
        "Hostinfo": { "Hostname": "known", "OS": "linux" },
    });
    let out = coord_api::__test_handle_register(state, &[mkey; 32], &body.to_string()).await.unwrap();
    serde_json::from_str(&out).unwrap()
}

async fn map_status(state: &Arc<CoordinatorState>, mkey: u8, stream: bool) -> StatusCode {
    let body = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([mkey.wrapping_add(1); 32])),
        "Stream": stream,
    });
    coord_api::__test_map_request(state.clone(), [mkey; 32], &body.to_string()).await.status()
}

#[tokio::test]
async fn suspended_tenant_is_cut_off_and_unsuspend_restores() {
    let (app, state) = setup();
    let t = create_test_tenant(&state, "suspend-me").await;
    let other = create_test_tenant(&state, "suspend-other").await;
    let key = api_key(&app, serde_json::json!({ "tenant_id": t.to_string(), "reusable": true })).await;
    let key = key["key"].as_str().unwrap().to_string();
    let other_key = api_key(&app, serde_json::json!({ "tenant_id": other.to_string() })).await;

    assert_eq!(register_routes(&state, 230, &key, "s-1", None).await["MachineAuthorized"], true);
    assert_eq!(register_routes(&state, 240, other_key["key"].as_str().unwrap(), "o-1", None).await["MachineAuthorized"], true);
    let mut stream = open_stream(&state, 230).await;
    let _other_stream = open_stream(&state, 240).await;

    // Summaries start unsuspended.
    let (_, body) = api_call(&app, "GET", format!("/api/tenants/{t}"), None).await;
    assert_eq!(body["tenant"]["suspended"], false);

    set_suspended(&app, t, true).await;

    // The live stream ends promptly.
    let mut ended = false;
    for _ in 0..5 {
        if next_map_frame(&mut stream).await.is_none() {
            ended = true;
            break;
        }
    }
    assert!(ended, "suspended tenant's map stream must end");

    // Summaries report it.
    let (_, body) = api_call(&app, "GET", format!("/api/tenants/{t}"), None).await;
    assert_eq!(body["tenant"]["suspended"], true);
    let (_, body) = api_call(&app, "GET", "/api/tenants".into(), None).await;
    let listed = body["tenants"].as_array().unwrap().iter().find(|x| x["id"] == t.to_string()).unwrap().clone();
    assert_eq!(listed["suspended"], true);

    // Register (new machine with key, and known-machine re-register) is refused cleanly.
    let resp = register_routes(&state, 232, &key, "s-2", None).await;
    assert_eq!(resp["MachineAuthorized"], false);
    assert!(resp["Error"].as_str().unwrap().contains("suspended"));
    assert!(state.store().get_node_by_machine_key(&[232u8; 32]).await.is_none());
    let resp = reregister_known(&state, 230).await;
    assert_eq!(resp["MachineAuthorized"], false);
    assert!(resp["Error"].as_str().unwrap().contains("suspended"));

    // Map requests are refused without a 500.
    assert_eq!(map_status(&state, 230, false).await, StatusCode::FORBIDDEN);
    assert_eq!(map_status(&state, 230, true).await, StatusCode::FORBIDDEN);

    // New pre-auth keys are refused.
    let (status, body) = api_call(&app, "POST", "/api/preauth-keys".into(), Some(serde_json::json!({ "tenant_id": t.to_string() }))).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["code"], "tenant_suspended");

    // Other tenants are unaffected: their stream is still live and they can poll.
    assert_eq!(map_status(&state, 240, false).await, StatusCode::OK);
    let (_, body) = api_call(&app, "GET", format!("/api/tenants/{other}"), None).await;
    assert_eq!(body["tenant"]["suspended"], false);

    // Unsuspend restores normal operation.
    set_suspended(&app, t, false).await;
    assert_eq!(reregister_known(&state, 230).await["MachineAuthorized"], true);
    let _restored = open_stream(&state, 230).await;
    assert_eq!(register_routes(&state, 232, &key, "s-2", None).await["MachineAuthorized"], true);
    api_key(&app, serde_json::json!({ "tenant_id": t.to_string() })).await;
}

#[tokio::test]
async fn suspension_does_not_consume_single_use_key() {
    let (app, state) = setup();
    let t = create_test_tenant(&state, "suspend-key").await;
    let k = api_key(&app, serde_json::json!({ "tenant_id": t.to_string() })).await;
    let key = k["key"].as_str().unwrap();

    set_suspended(&app, t, true).await;
    assert_eq!(register_routes(&state, 234, key, "later", None).await["MachineAuthorized"], false);
    set_suspended(&app, t, false).await;
    assert_eq!(register_routes(&state, 234, key, "later", None).await["MachineAuthorized"], true);
}

#[tokio::test]
async fn set_suspended_unknown_or_invalid_tenant() {
    let (app, _state) = setup();
    let body = Some(serde_json::json!({ "suspended": true }));
    let (status, _) = api_call(&app, "PUT", format!("/api/tenants/{}/suspended", uuid::Uuid::new_v4()), body.clone()).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = api_call(&app, "PUT", "/api/tenants/not-a-uuid/suspended".into(), body).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn set_suspended_requires_admin_auth() {
    let (app, state) = setup();
    let t = create_test_tenant(&state, "suspend-auth").await;
    let resp = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(format!("/api/tenants/{t}/suspended"))
                .header("content-type", "application/json")
                .body(Body::from(r#"{"suspended":true}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    assert!(!state.store().get_tenant(t).await.unwrap().suspended);
}

#[tokio::test]
async fn deleted_node_map_is_401_not_500() {
    let (app, state) = setup();
    let t = create_test_tenant(&state, "deleted-map").await;
    let k = api_key(&app, serde_json::json!({ "tenant_id": t.to_string() })).await;
    register_routes(&state, 236, k["key"].as_str().unwrap(), "gone", None).await;
    let id = node_id_of(&state, 236).await;
    let (status, _) = api_call(&app, "DELETE", format!("/api/nodes/{id}"), None).await;
    assert_eq!(status, StatusCode::OK);

    assert_eq!(map_status(&state, 236, false).await, StatusCode::UNAUTHORIZED);
    assert_eq!(map_status(&state, 236, true).await, StatusCode::UNAUTHORIZED);
    // Never-registered machines too.
    assert_eq!(map_status(&state, 238, false).await, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn hierarchy_parent_blocked_when_child_suspended() {
    let (_, state) = setup();
    let parent = state.store().create_tenant("susp-parent".into(), None, None).await.unwrap();
    let child = state.store().create_tenant("susp-child".into(), Some(parent.id), None).await.unwrap();
    if let coord_store::Store::Memory(m) = state.store().as_ref() {
        m.tenants_for_test().lock().unwrap().get_mut(&child.id).unwrap().federation_posture =
            coord_core::FederationPosture::Open;
    }
    register_node_for(&state, parent.id, [230u8; 32], 231, "susp-parent-node").await;
    register_node_for(&state, child.id, [240u8; 32], 241, "susp-child-node").await;
    state.store().set_tenant_suspended(child.id, true).await.unwrap();

    let map_body = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([231u8; 32])),
    });
    let result = coord_api::__test_handle_map(&state, &[230u8; 32], &map_body.to_string())
        .await
        .unwrap();
    let resp: serde_json::Value = serde_json::from_str(&result).unwrap();
    let peers = resp["Peers"].as_array().map(|p| p.len()).unwrap_or(0);
    assert_eq!(peers, 0, "parent must not see a suspended child's nodes");
}

// ── Security hardening: re-auth, client field bounds, Noise limits ──

/// Register `mkey` with an explicit node key byte / old node key / auth key.
async fn register_raw(
    state: &Arc<CoordinatorState>,
    mkey: u8,
    node_key: u8,
    old_node_key: Option<u8>,
    auth_key: Option<&str>,
    hostinfo: serde_json::Value,
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([node_key; 32])),
        "Hostinfo": hostinfo,
    });
    if let Some(old) = old_node_key {
        body["OldNodeKey"] = serde_json::json!(format!("nodekey:{}", hex::encode([old; 32])));
    }
    if let Some(k) = auth_key {
        body["Auth"] = serde_json::json!({ "AuthKey": k });
    }
    let out = coord_api::__test_handle_register(state, &[mkey; 32], &body.to_string()).await.unwrap();
    serde_json::from_str(&out).unwrap()
}

#[tokio::test]
async fn reauth_with_new_key_replaces_owner_tags_and_auto_approvals() {
    let (app, state) = setup();
    let t = create_test_tenant(&state, "reauth").await;
    let (status, _) = api_call(&app, "PUT", format!("/api/tenants/{t}/auto-approvers"),
        Some(serde_json::json!({ "routes": { "10.0.0.0/8": ["tag:relay"] } }))).await;
    assert_eq!(status, StatusCode::OK);
    let tagged = api_key(&app, serde_json::json!({
        "tenant_id": t.to_string(), "owner": "did:plc:alice", "tags": ["tag:relay"],
    })).await;
    let plain = api_key(&app, serde_json::json!({
        "tenant_id": t.to_string(), "owner": "did:plc:bob", "ephemeral": true,
    })).await;

    let hi = serde_json::json!({ "Hostname": "relay", "OS": "linux", "RoutableIPs": ["10.1.0.0/16"] });
    let r = register_raw(&state, 60, 61, None, Some(tagged["key"].as_str().unwrap()), hi.clone()).await;
    assert_eq!(r["MachineAuthorized"], true);
    let nid = node_id_of(&state, 60).await;
    let (_, n) = api_call(&app, "GET", format!("/api/nodes/{nid}"), None).await;
    assert_eq!(n["approved_routes"], serde_json::json!(["10.1.0.0/16"]));
    let ip_before = n["ipv4"].clone();

    // The node's own map stream must hear about the re-auth.
    let mut own_stream = open_stream(&state, 60).await;

    // `tailscale up --force-reauth --auth-key=<untagged>`: new node key + OldNodeKey + key.
    let r = register_raw(&state, 60, 62, Some(61), Some(plain["key"].as_str().unwrap()), hi.clone()).await;
    assert_eq!(r["MachineAuthorized"], true, "{r}");
    assert_eq!(node_id_of(&state, 60).await, nid, "same machine keeps its node");
    let (_, n) = api_call(&app, "GET", format!("/api/nodes/{nid}"), None).await;
    assert_eq!(n["owner"], "did:plc:bob", "{n}");
    assert_eq!(n["tags"], serde_json::json!([]), "{n}");
    assert_eq!(n["ephemeral"], true, "{n}");
    assert_eq!(n["approved_routes"], serde_json::json!([]), "auto-approval from the old tags must not persist: {n}");
    assert_eq!(n["advertised_routes"], serde_json::json!(["10.1.0.0/16"]), "{n}");
    assert_eq!(n["ipv4"], ip_before, "{n}");
    let frame = next_map_frame(&mut own_stream).await.expect("re-auth pushes a snapshot");
    assert!(frame["Node"].is_object(), "{frame}");

    // Re-auth back onto a tagged key re-evaluates auto-approval.
    let tagged2 = api_key(&app, serde_json::json!({ "tenant_id": t.to_string(), "tags": ["tag:relay"] })).await;
    let r = register_raw(&state, 60, 63, Some(62), Some(tagged2["key"].as_str().unwrap()), hi).await;
    assert_eq!(r["MachineAuthorized"], true);
    let (_, n) = api_call(&app, "GET", format!("/api/nodes/{nid}"), None).await;
    assert_eq!(n["tags"], serde_json::json!(["tag:relay"]), "{n}");
    assert_eq!(n["approved_routes"], serde_json::json!(["10.1.0.0/16"]), "{n}");
}

#[tokio::test]
async fn reregister_with_matching_node_key_does_not_burn_single_use_key() {
    let (app, state) = setup();
    let t = create_test_tenant(&state, "no-burn").await;
    let first = api_key(&app, serde_json::json!({ "tenant_id": t.to_string(), "tags": ["tag:a"] })).await;
    let hi = serde_json::json!({ "Hostname": "box", "OS": "linux" });
    assert_eq!(register_raw(&state, 66, 67, None, Some(first["key"].as_str().unwrap()), hi.clone()).await["MachineAuthorized"], true);

    // Restart re-sending the (now used) key with the same node key stays authorized.
    assert_eq!(register_raw(&state, 66, 67, None, Some(first["key"].as_str().unwrap()), hi.clone()).await["MachineAuthorized"], true);

    // Same node key + a fresh single-use key: authorized, key untouched, attrs unchanged.
    let fresh = api_key(&app, serde_json::json!({ "tenant_id": t.to_string(), "tags": ["tag:b"] })).await;
    assert_eq!(register_raw(&state, 66, 67, None, Some(fresh["key"].as_str().unwrap()), hi.clone()).await["MachineAuthorized"], true);
    let (_, n) = api_call(&app, "GET", format!("/api/nodes/{}", node_id_of(&state, 66).await), None).await;
    assert_eq!(n["tags"], serde_json::json!(["tag:a"]), "{n}");
    let r = register_raw(&state, 68, 69, None, Some(fresh["key"].as_str().unwrap()), hi).await;
    assert_eq!(r["MachineAuthorized"], true, "single-use key must still be usable: {r}");
}

#[tokio::test]
async fn reauth_with_other_tenants_key_refused_without_consuming_it() {
    let (app, state) = setup();
    let t = create_test_tenant(&state, "mine").await;
    let other = create_test_tenant(&state, "theirs").await;
    let mine = state.store().create_preauth_key(t, false).await.unwrap();
    let theirs = api_key(&app, serde_json::json!({ "tenant_id": other.to_string() })).await;
    let theirs = theirs["key"].as_str().unwrap();
    let hi = serde_json::json!({ "Hostname": "box", "OS": "linux" });
    register_raw(&state, 70, 71, None, Some(&mine), hi.clone()).await;

    let r = register_raw(&state, 70, 72, Some(71), Some(theirs), hi.clone()).await;
    assert_eq!(r["MachineAuthorized"], false, "{r}");
    assert!(r["Error"].as_str().unwrap().contains("different tailnet"), "{r}");
    assert_eq!(register_raw(&state, 74, 75, None, Some(theirs), hi).await["MachineAuthorized"], true);
}

#[tokio::test]
async fn hostnames_are_single_dns_labels_and_cannot_spoof_fqdns() {
    let (app, state) = setup();
    let t = create_test_tenant(&state, "names").await;
    let key = state.store().create_preauth_key(t, true).await.unwrap();
    let long = "Ab".repeat(200);
    for (mkey, name) in [(80u8, "observer"), (82, "victim.other.mesh.local"), (84, "..."), (86, long.as_str()), (88, "My Laptop")] {
        let r = register_raw(&state, mkey, mkey + 1, None, Some(&key), serde_json::json!({ "Hostname": name, "OS": "x".repeat(5000) })).await;
        assert_eq!(r["MachineAuthorized"], true);
    }
    let map = map_of(&state, 80, None).await;
    let names: std::collections::HashMap<i64, String> = map["Peers"].as_array().unwrap().iter()
        .map(|p| (p["ID"].as_i64().unwrap(), p["Name"].as_str().unwrap().to_string()))
        .collect();
    let dots = names[&node_id_of(&state, 82).await].clone();
    assert_eq!(dots, "victim-other-mesh-local.mesh.local.");
    let empty_id = node_id_of(&state, 84).await;
    assert_eq!(names[&empty_id], format!("node-{empty_id}.mesh.local."));
    let label = names[&node_id_of(&state, 86).await].trim_end_matches(".mesh.local.").to_string();
    assert_eq!(label.len(), 63);
    assert!(label.chars().all(|c| c.is_ascii_lowercase()), "{label}");
    assert_eq!(names[&node_id_of(&state, 88).await], "my-laptop.mesh.local.");
    for name in names.values() {
        assert_eq!(name.matches('.').count(), 3, "exactly <label>.mesh.local.: {name}");
    }
    let (_, n) = api_call(&app, "GET", format!("/api/nodes/{}", node_id_of(&state, 82).await), None).await;
    assert_eq!(n["hostname"], "victim-other-mesh-local", "stored sanitised: {n}");
    let os = state.store().get_node_info(coord_core::NodeId::new(node_id_of(&state, 82).await)).await.unwrap().info.os;
    assert_eq!(os.len(), coord_core::sanitize::MAX_OS_LEN);

    // Admin renames are re-sanitised on the way out too.
    let id = node_id_of(&state, 88).await;
    let (status, _) = api_call(&app, "POST", format!("/api/nodes/{id}/name"), Some(serde_json::json!({ "name": "a.observer" }))).await;
    assert_eq!(status, StatusCode::OK);
    let map = map_of(&state, 80, None).await;
    let peer = map["Peers"].as_array().unwrap().iter().find(|p| p["ID"] == id).unwrap().clone();
    assert_eq!(peer["Name"], "a-observer.mesh.local.");
}

#[tokio::test]
async fn map_bounds_endpoints_and_validates_disco_key() {
    let (_, state) = setup();
    let t = create_test_tenant(&state, "ep-bounds").await;
    let key = state.store().create_preauth_key(t, true).await.unwrap();
    for mkey in [90u8, 92] {
        register_raw(&state, mkey, mkey + 1, None, Some(&key), serde_json::json!({ "Hostname": "n", "OS": "linux" })).await;
    }
    let mut endpoints: Vec<String> = (0..200).map(|i| format!("192.0.2.{}:41641", i % 250)).collect();
    endpoints.insert(0, "x".repeat(100_000));
    endpoints.insert(0, "not an endpoint".into());
    let push = |disco: String, eps: Vec<String>| serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([93u8; 32])),
        "DiscoKey": disco,
        "Endpoints": eps,
    }).to_string();
    let good_disco = format!("discokey:{}", "cd".repeat(32));
    coord_api::__test_handle_map(&state, &[92u8; 32], &push(good_disco.clone(), endpoints)).await.unwrap();
    let peer = map_of(&state, 90, None).await["Peers"][0].clone();
    let eps = peer["Endpoints"].as_array().unwrap();
    assert_eq!(eps.len(), coord_core::sanitize::MAX_ENDPOINTS);
    assert_eq!(eps[0], "192.0.2.0:41641");
    assert_eq!(peer["DiscoKey"], good_disco);

    // Oversized / malformed disco keys are ignored (previous value kept).
    for bad in [format!("discokey:{}", "a".repeat(10_000)), "discokey:zz".into(), "cd".repeat(32)] {
        coord_api::__test_handle_map(&state, &[92u8; 32], &push(bad, vec![])).await.unwrap();
        assert_eq!(map_of(&state, 90, None).await["Peers"][0]["DiscoKey"], good_disco);
    }
}

#[tokio::test]
async fn noise_connection_cap_refuses_before_handshake() {
    let key = coord_noise::generate_control_key();
    let ts2021 = || Request::builder()
        .method("POST")
        .uri("/ts2021")
        .header("upgrade", "tailscale-control-protocol")
        .header("connection", "upgrade")
        .header("X-Tailscale-Handshake", "AAAA")
        .body(Body::empty())
        .unwrap();

    let capped = coord_api::router(Arc::new(CoordinatorState::new(key.clone()).with_max_noise_connections(0)));
    let resp = capped.oneshot(ts2021()).await.unwrap();
    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);

    // With headroom the same request reaches the handshake (and fails there).
    let open = coord_api::router(Arc::new(CoordinatorState::new(key)));
    let resp = open.oneshot(ts2021()).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    const { assert!(coord_api::DEFAULT_MAX_NOISE_CONNECTIONS >= 1024) };
}

#[tokio::test]
async fn noise_h2_caps_streams_and_body_size() {
    let (_, state) = setup();

    // The server advertises a small SETTINGS_MAX_CONCURRENT_STREAMS.
    let (client_io, server_io) = tokio::io::duplex(1 << 20);
    tokio::spawn(coord_api::__test_serve_control_h2(state.clone(), server_io, [99u8; 32]));
    let (mut client, mut conn) = h2::client::handshake(client_io).await.unwrap();
    // Drive the connection until the server's SETTINGS frame has been applied.
    let req = axum::http::Request::post("/machine/register").body(()).unwrap();
    let (resp, mut send) = client.send_request(req, false).unwrap();
    send.send_data(bytes::Bytes::from_static(b"{}"), true).unwrap();
    let resp = tokio::select! {
        r = resp => r.unwrap(),
        _ = &mut conn => panic!("connection closed"),
    };
    assert!(resp.status().is_server_error() || resp.status().is_client_error());
    assert_eq!(conn.max_concurrent_send_streams(), coord_api::MAX_CONCURRENT_STREAMS as usize);
    const { assert!(coord_api::MAX_CONCURRENT_STREAMS <= 16) };
    drop(client);

    // Bodies over the cap are rejected (not buffered); small ones are processed.
    let (client_io, server_io) = tokio::io::duplex(1 << 20);
    tokio::spawn(coord_api::__test_serve_control_h2(state.clone(), server_io, [98u8; 32]));
    let (mut sender, conn) = hyper::client::conn::http2::handshake(
        hyper_util::rt::TokioExecutor::new(),
        hyper_util::rt::TokioIo::new(client_io),
    )
    .await
    .unwrap();
    tokio::spawn(conn);
    let post = |len: usize| {
        axum::http::Request::post("/machine/register")
            .body(http_body_util::Full::new(bytes::Bytes::from(vec![b' '; len])))
            .unwrap()
    };
    let resp = sender.send_request(post(coord_api::MAX_CONTROL_BODY + 1)).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    assert!(String::from_utf8_lossy(&body).contains("too large"));
    let resp = sender.send_request(post(1024)).await.unwrap();
    assert_ne!(resp.status(), StatusCode::BAD_REQUEST, "small body must reach the handler");
    const { assert!(coord_api::MAX_CONTROL_BODY <= 512 * 1024) };
}

#[tokio::test]
async fn suspension_tells_clients_to_drop_peers_before_cutting_the_stream() {
    let (app, state) = setup();
    let t = create_test_tenant(&state, "cutoff").await;
    let key = api_key(&app, serde_json::json!({ "tenant_id": t.to_string(), "reusable": true })).await;
    let key = key["key"].as_str().unwrap().to_string();
    register_routes(&state, 70, &key, "cut-a", None).await;
    register_routes(&state, 80, &key, "cut-b", None).await;
    let peer_b = state.store().get_node_by_machine_key(&[80u8; 32]).await.unwrap().as_i64();
    let mut stream = open_stream(&state, 70).await;

    set_suspended(&app, t, true).await;

    let mut cutoff = None;
    for _ in 0..8 {
        match next_map_frame(&mut stream).await {
            Some(frame) if frame.get("PeersRemoved").is_some() => cutoff = Some(frame),
            Some(_) => continue,
            None => break,
        }
    }
    let cutoff = cutoff.expect("a cutoff frame before the stream ends");
    assert!(cutoff["PeersRemoved"].as_array().unwrap().iter().any(|id| id == peer_b));
    assert_eq!(cutoff["PacketFilter"], serde_json::json!([]), "deny-all filter");
}

// ── Tenant identity: tailnet + user names shown in Tailscale clients ──

#[tokio::test]
async fn identity_names_register_response_and_netmap() {
    let (app, state) = setup();
    let t = create_test_tenant(&state, "identity").await;

    // Unknown identity: legacy placeholders, unchanged behaviour
    let k0 = api_key(&app, serde_json::json!({ "tenant_id": t.to_string(), "owner": "u-alice" })).await;
    let before = register_routes(&state, 70, k0["key"].as_str().unwrap(), "alice-laptop", None).await;
    assert_eq!(before["Login"]["LoginName"], "mesh@coordinator.local");

    // Push identity
    let (status, json) = api_call(
        &app,
        "PUT",
        format!("/api/tenants/{t}/identity"),
        Some(serde_json::json!({
            "tailnet_name": "Alice's tailnet",
            "users": {
                "u-alice": { "login_name": "alice.bsky.social", "display_name": "Alice" },
                "u-bob": { "login_name": "bob.bsky.social" }
            }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{json}");

    // Register response names the key's owner
    let k1 = api_key(&app, serde_json::json!({ "tenant_id": t.to_string(), "owner": "u-bob" })).await;
    let reg = register_routes(&state, 80, k1["key"].as_str().unwrap(), "bob-phone", None).await;
    assert_eq!(reg["Login"]["LoginName"], "bob.bsky.social");
    assert_eq!(reg["Login"]["DisplayName"], "bob.bsky.social", "display name falls back to login");
    assert_eq!(reg["User"]["ID"], reg["Login"]["ID"]);
    assert_ne!(reg["User"]["ID"], 1);

    // Netmap: tailnet name as Domain, distinct users with profiles for self + peers
    let map_body = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([81u8; 32])),
    });
    let map: serde_json::Value = serde_json::from_str(
        &coord_api::__test_handle_map(&state, &[80u8; 32], &map_body.to_string()).await.unwrap(),
    )
    .unwrap();
    assert_eq!(map["Domain"], "Alice's tailnet");
    let bob_id = map["Node"]["User"].as_i64().unwrap();
    let alice_id = map["Peers"][0]["User"].as_i64().unwrap();
    assert_ne!(bob_id, alice_id);
    let profiles = map["UserProfiles"].as_array().unwrap();
    let login_of = |id: i64| {
        profiles.iter().find(|p| p["ID"].as_i64() == Some(id)).map(|p| p["LoginName"].clone())
    };
    assert_eq!(login_of(bob_id), Some(serde_json::json!("bob.bsky.social")));
    assert_eq!(login_of(alice_id), Some(serde_json::json!("alice.bsky.social")));

    // GET returns what was stored
    let (status, json) = api_call(&app, "GET", format!("/api/tenants/{t}/identity"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["users"]["u-alice"]["display_name"], "Alice");
}

#[tokio::test]
async fn identity_rejects_bad_input_and_needs_admin_auth() {
    let (app, state) = setup();
    let t = create_test_tenant(&state, "identity-bad").await;
    for bad in [
        serde_json::json!({ "users": { "u": { "login_name": "" } } }),
        serde_json::json!({ "users": { "u": { "login_name": "x".repeat(300) } } }),
        serde_json::json!({ "tailnet_name": "y".repeat(300) }),
    ] {
        let (status, _) = api_call(&app, "PUT", format!("/api/tenants/{t}/identity"), Some(bad)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(format!("/api/tenants/{t}/identity"))
                .header("content-type", "application/json")
                .body(Body::from(r#"{"tailnet_name":"x"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

// ── Built-in DERP relay (ADR-0027) ──

#[tokio::test]
async fn default_derp_map_has_no_third_party_relays() {
    let (_, state) = setup();
    assert!(state.derp().default_map().regions.is_empty());

    let key = coord_noise::generate_control_key();
    let state = CoordinatorState::new(key).with_builtin_relay_region("derp.example.com", 3478);
    let map = state.derp().default_map().clone();
    assert_eq!(map.regions.len(), 1);
    let node = &map.regions[&1].nodes[0];
    assert_eq!((node.host_name.as_str(), node.stun_port, node.derp_port), ("derp.example.com", 3478, 443));
}

#[tokio::test]
async fn derp_http_endpoints() {
    let (app, _) = setup();

    // Without an upgrade the relay endpoint refuses
    let resp = app.clone().oneshot(Request::builder().uri("/derp").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(resp.status(), StatusCode::UPGRADE_REQUIRED);

    for path in ["/derp/probe", "/derp/latency-check"] {
        let resp = app.clone().oneshot(Request::builder().uri(path).body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(resp.headers()["access-control-allow-origin"], "*");
    }

    // Captive-portal check echoes a well-formed challenge and nothing else
    let resp = app
        .clone()
        .oneshot(Request::builder().uri("/generate_204").header("X-Tailscale-Challenge", "abc-123:x").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    assert_eq!(resp.headers()["x-tailscale-response"], "response abc-123:x");
    let resp = app
        .clone()
        .oneshot(Request::builder().uri("/generate_204").header("X-Tailscale-Challenge", "bad value!").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    assert!(resp.headers().get("x-tailscale-response").is_none());
}

#[tokio::test]
async fn relay_admits_registered_nodes_of_live_tenants_only() {
    use coord_derp::Admission;
    let (app, state) = setup();
    let parent = create_test_tenant(&state, "relay-parent").await;
    let child = state.store().create_tenant("relay-child".into(), Some(parent), None).await.unwrap().id;
    let other = create_test_tenant(&state, "relay-other").await;

    let mut scopes = vec![];
    for (i, t) in [parent, child, other].into_iter().enumerate() {
        let k = api_key(&app, serde_json::json!({ "tenant_id": t.to_string() })).await;
        let mkey = 200 + i as u8;
        register_routes(&state, mkey, k["key"].as_str().unwrap(), "relay-node", None).await;
        let adm = coord_api::derp_handler::StoreAdmission::for_state(&state);
        scopes.push(adm.admit(&[mkey.wrapping_add(1); 32]).await.expect("registered node is admitted"));
    }
    assert!(scopes[0].can_reach(&scopes[1]), "parent and child reach each other");
    assert!(!scopes[0].can_reach(&scopes[2]), "unrelated tenants do not");

    let adm = coord_api::derp_handler::StoreAdmission::for_state(&state);
    assert!(adm.admit(&[9u8; 32]).await.is_none(), "unknown key refused");

    state.store().set_tenant_suspended(other, true).await.unwrap();
    assert!(adm.admit(&[203u8; 32]).await.is_none(), "suspended tenant refused");
}

// ── Device access: member mode (ADR-0036) ──

async fn member_map(state: &Arc<CoordinatorState>, mkey: u8) -> serde_json::Value {
    let body = serde_json::json!({ "Version": 2, "NodeKey": format!("nodekey:{}", hex::encode([mkey.wrapping_add(1); 32])) });
    serde_json::from_str(&coord_api::__test_handle_map(state, &[mkey; 32], &body.to_string()).await.unwrap()).unwrap()
}

fn peer_names(map: &serde_json::Value) -> Vec<String> {
    let mut v: Vec<String> = map["Peers"]
        .as_array()
        .map(|a| a.iter().map(|p| p["Name"].as_str().unwrap().split('.').next().unwrap().to_string()).collect())
        .unwrap_or_default();
    v.sort();
    v
}

#[tokio::test]
async fn member_mode_isolates_members_and_rules_open_single_ports() {
    let (app, state) = setup();
    let t = create_test_tenant(&state, "member-mode").await;
    let alice = api_key(&app, serde_json::json!({ "tenant_id": t.to_string(), "owner": "alice", "reusable": true })).await;
    let bob = api_key(&app, serde_json::json!({ "tenant_id": t.to_string(), "owner": "bob", "reusable": true })).await;
    register_routes(&state, 110, alice["key"].as_str().unwrap(), "alice-laptop", None).await;
    register_routes(&state, 112, alice["key"].as_str().unwrap(), "alice-server", None).await;
    register_routes(&state, 120, bob["key"].as_str().unwrap(), "bob-phone", None).await;

    // Open mode (default): everyone sees everyone, allow-all filter
    let m = member_map(&state, 120).await;
    assert_eq!(peer_names(&m), vec!["alice-laptop", "alice-server"]);
    assert_eq!(m["PacketFilter"][0]["SrcIPs"][0], "*");

    // Member mode: own devices only
    let (status, _) = api_call(&app, "PUT", format!("/api/tenants/{t}/access"), Some(serde_json::json!({ "mode": "member" }))).await;
    assert_eq!(status, StatusCode::OK);
    let m = member_map(&state, 120).await;
    assert!(peer_names(&m).is_empty(), "bob sees none of alice's devices");
    assert_eq!(m["PacketFilter"], serde_json::json!([]), "and accepts nothing");
    let m = member_map(&state, 110).await;
    assert_eq!(peer_names(&m), vec!["alice-server"]);

    // alice opens tcp/3000 on alice-server to bob's devices
    let server_id = member_map(&state, 112).await["Node"]["ID"].as_i64().unwrap();
    let (status, json) = api_call(
        &app,
        "PUT",
        format!("/api/tenants/{t}/access"),
        Some(serde_json::json!({
            "mode": "member",
            "rules": [{ "src_owner": "bob", "dst_node": server_id, "ports": [{ "proto": "tcp", "first": 3000, "last": 3000 }] }]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{json}");

    // bob now sees only alice-server; alice-laptop stays hidden
    assert_eq!(peer_names(&member_map(&state, 120).await), vec!["alice-server"]);
    // alice-server accepts bob on tcp/3000 only
    let m = member_map(&state, 112).await;
    let filters = m["PacketFilter"].as_array().unwrap();
    let shared = filters.iter().find(|f| f["IPProto"] == serde_json::json!([6])).expect("tcp filter");
    assert_eq!(shared["DstPorts"][0]["Ports"], serde_json::json!({ "First": 3000, "Last": 3000 }));
    assert_eq!(shared["SrcIPs"].as_array().unwrap().len(), 1);
    // alice-laptop is unaffected by the rule
    let m = member_map(&state, 110).await;
    assert!(m["PacketFilter"].as_array().unwrap().iter().all(|f| f.get("IPProto").is_none()));

    // GET returns the stored rules; bad input is refused
    let (_, got) = api_call(&app, "GET", format!("/api/tenants/{t}/access"), None).await;
    assert_eq!(got["rules"][0]["dst_node"], server_id);
    let (status, _) = api_call(
        &app,
        "PUT",
        format!("/api/tenants/{t}/access"),
        Some(serde_json::json!({ "mode": "member", "rules": [{ "dst_node": 1, "ports": [{ "first": 1, "last": 1 }] }] })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "a rule without a source is refused");
}

#[tokio::test]
async fn member_mode_stream_removes_peers_when_access_ends() {
    let (app, state) = setup();
    let t = create_test_tenant(&state, "member-stream").await;
    let alice = api_key(&app, serde_json::json!({ "tenant_id": t.to_string(), "owner": "alice" })).await;
    let bob = api_key(&app, serde_json::json!({ "tenant_id": t.to_string(), "owner": "bob" })).await;
    register_routes(&state, 130, alice["key"].as_str().unwrap(), "alice-box", None).await;
    register_routes(&state, 140, bob["key"].as_str().unwrap(), "bob-box", None).await;
    let alice_id = member_map(&state, 130).await["Node"]["ID"].as_i64().unwrap();

    let open_rule = serde_json::json!({
        "mode": "member",
        "rules": [{ "src_owner": "bob", "dst_node": alice_id, "ports": [{ "first": 22, "last": 22 }] }]
    });
    api_call(&app, "PUT", format!("/api/tenants/{t}/access"), Some(open_rule)).await;

    // bob's stream starts with alice-box visible
    let mut stream = open_stream(&state, 140).await;

    // Access ends: bob's device is told to drop the peer by id
    api_call(&app, "PUT", format!("/api/tenants/{t}/access"), Some(serde_json::json!({ "mode": "member" }))).await;
    let update = tokio::time::timeout(std::time::Duration::from_secs(3), next_map_frame(&mut stream))
        .await
        .expect("update after access change")
        .expect("frame");
    assert!(update.get("Peers").is_none());
    assert_eq!(update["PeersRemoved"], serde_json::json!([alice_id]));
    assert_eq!(update["PacketFilter"], serde_json::json!([]));
}

// ── Tenant DNS: device names and service records (ADR-0028) ──

#[tokio::test]
async fn dns_gives_devices_names_and_shows_each_device_only_its_records() {
    let (app, state) = setup();
    let t = create_test_tenant(&state, "dns-names").await;
    let alice = api_key(&app, serde_json::json!({ "tenant_id": t.to_string(), "owner": "alice", "reusable": true })).await;
    let bob = api_key(&app, serde_json::json!({ "tenant_id": t.to_string(), "owner": "bob" })).await;
    register_routes(&state, 150, alice["key"].as_str().unwrap(), "alice-laptop", None).await;
    register_routes(&state, 152, alice["key"].as_str().unwrap(), "alice-server", None).await;
    register_routes(&state, 160, bob["key"].as_str().unwrap(), "bob-phone", None).await;
    let server = member_map(&state, 152).await;
    let server_id = server["Node"]["ID"].as_i64().unwrap();
    let server_ip = server["Node"]["Addresses"][0].as_str().unwrap().split('/').next().unwrap().to_string();

    // Without DNS: legacy names, empty config
    let m = member_map(&state, 150).await;
    assert_eq!(m["Node"]["Name"], "alice-laptop.mesh.local.");
    assert!(m["DNSConfig"].get("Routes").is_none());

    let (status, json) = api_call(
        &app,
        "PUT",
        format!("/api/tenants/{t}/dns"),
        Some(serde_json::json!({
            "base_domain": "ts.example.com",
            "tailnet_label": "harbor",
            "upstream": ["1.1.1.1"],
            "records": [{ "name": "notes", "node": server_id, "owner": "alice" }]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{json}");

    // alice's laptop: device names under the tailnet, the private record, split DNS with an upstream
    let m = member_map(&state, 150).await;
    assert_eq!(m["Node"]["Name"], "alice-laptop.harbor.ts.example.com.");
    let dns = &m["DNSConfig"];
    assert_eq!(dns["Proxied"], true);
    assert_eq!(dns["Domains"], serde_json::json!(["harbor.ts.example.com"]));
    assert_eq!(dns["Routes"]["ts.example.com"], serde_json::json!([{ "Addr": "1.1.1.1" }]));
    assert_eq!(dns["ExtraRecords"], serde_json::json!([{ "Name": "notes.ts.example.com", "Value": server_ip }]));
    assert!(peer_names(&m).contains(&"alice-server".to_string()));

    // bob's phone does not get alice's private record
    let m = member_map(&state, 160).await;
    assert!(m["DNSConfig"].get("ExtraRecords").is_none());

    // The route is never sent without resolvers (it would black-hole the whole domain)
    api_call(
        &app,
        "PUT",
        format!("/api/tenants/{t}/dns"),
        Some(serde_json::json!({ "base_domain": "ts.example.com", "tailnet_label": "harbor" })),
    )
    .await;
    let m = member_map(&state, 150).await;
    assert!(m["DNSConfig"].get("Routes").is_none());

    // Bad input is refused
    for bad in [
        serde_json::json!({ "base_domain": "ts.example.com", "upstream": ["not-an-ip"] }),
        serde_json::json!({ "base_domain": "ts.example.com", "records": [{ "name": "a.b", "node": 1 }] }),
        serde_json::json!({ "tailnet_label": "harbor" }),
    ] {
        let (status, _) = api_call(&app, "PUT", format!("/api/tenants/{t}/dns"), Some(bad)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
}

#[tokio::test]
async fn dns_record_is_hidden_when_its_device_is_not_visible() {
    let (app, state) = setup();
    let t = create_test_tenant(&state, "dns-hidden").await;
    let alice = api_key(&app, serde_json::json!({ "tenant_id": t.to_string(), "owner": "alice" })).await;
    let bob = api_key(&app, serde_json::json!({ "tenant_id": t.to_string(), "owner": "bob" })).await;
    register_routes(&state, 170, alice["key"].as_str().unwrap(), "alice-box", None).await;
    register_routes(&state, 180, bob["key"].as_str().unwrap(), "bob-box", None).await;
    let alice_id = member_map(&state, 170).await["Node"]["ID"].as_i64().unwrap();
    let bob_id = member_map(&state, 180).await["Node"]["ID"].as_i64().unwrap();

    api_call(&app, "PUT", format!("/api/tenants/{t}/access"), Some(serde_json::json!({ "mode": "member" }))).await;
    // A record names bob's device as a viewer, but no access rule lets bob see alice's device
    api_call(
        &app,
        "PUT",
        format!("/api/tenants/{t}/dns"),
        Some(serde_json::json!({
            "base_domain": "ts.example.com",
            "records": [{ "name": "app", "node": alice_id, "nodes": [bob_id] }]
        })),
    )
    .await;
    let m = member_map(&state, 180).await;
    assert!(m["DNSConfig"].get("ExtraRecords").is_none(), "no address is revealed for a device that is not visible");
}

// ── Interactive device sign-in (ADR-0032) ──

fn sign_in_state() -> (axum::Router, Arc<CoordinatorState>) {
    let key = coord_noise::generate_control_key();
    let state = Arc::new(
        CoordinatorState::new(key)
            .with_admin_api_key(Some(TEST_ADMIN_KEY.to_string()))
            .with_device_auth_url(Some("https://dash.example/device".into()))
            .with_device_auth_wait(std::time::Duration::from_millis(150)),
    );
    (coord_api::router(state.clone()), state)
}

async fn register_no_key(state: &Arc<CoordinatorState>, mkey: u8, followup: Option<&str>) -> serde_json::Value {
    let mut body = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode([mkey.wrapping_add(1); 32])),
        "Hostinfo": { "Hostname": "Dave's Phone", "OS": "iOS" }
    });
    if let Some(f) = followup {
        body["Followup"] = serde_json::json!(f);
    }
    serde_json::from_str(&coord_api::__test_handle_register(state, &[mkey; 32], &body.to_string()).await.unwrap()).unwrap()
}

#[tokio::test]
async fn device_without_a_key_is_refused_when_sign_in_is_not_configured() {
    let (_, state) = setup();
    let resp = register_no_key(&state, 210, None).await;
    assert_eq!(resp["MachineAuthorized"], false);
    assert_eq!(resp["AuthURL"], "");
    assert!(resp["Error"].as_str().unwrap().contains("auth key"));
}

#[tokio::test]
async fn interactive_sign_in_registers_the_device_after_approval() {
    let (app, state) = sign_in_state();
    let t = create_test_tenant(&state, "sign-in").await;

    // 1. The device gets a sign-in URL
    let first = register_no_key(&state, 212, None).await;
    assert_eq!(first["MachineAuthorized"], false);
    let url = first["AuthURL"].as_str().unwrap().to_string();
    assert!(url.starts_with("https://dash.example/device/"));
    let id = url.rsplit('/').next().unwrap().to_string();

    // 2. The dashboard reads what to show the user
    let (status, info) = api_call(&app, "GET", format!("/api/device-auth/{id}"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(info["os"], "iOS");
    assert_eq!(info["pending"], true);
    assert!(info["registered_tenant_id"].is_null());
    assert_eq!(info["fingerprint"].as_str().unwrap().len(), 19);

    // 3. Before the user answers, the follow-up is told to keep waiting
    let waiting = register_no_key(&state, 212, Some(&url)).await;
    assert_eq!(waiting["MachineAuthorized"], false);
    assert_eq!(waiting["AuthURL"], url);

    // 4. The user approves; the follow-up registers the device for that owner
    let (status, _) = api_call(
        &app,
        "POST",
        format!("/api/device-auth/{id}/approve"),
        Some(serde_json::json!({ "tenant_id": t.to_string(), "owner": "u-dave" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let done = register_no_key(&state, 212, Some(&url)).await;
    assert_eq!(done["MachineAuthorized"], true, "{done}");

    let (_, nodes) = api_call(&app, "GET", format!("/api/tenants/{t}/nodes"), None).await;
    assert_eq!(nodes["nodes"][0]["owner"], "u-dave");

    // 5. The link worked once
    let (status, _) = api_call(&app, "GET", format!("/api/device-auth/{id}"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = api_call(
        &app,
        "POST",
        format!("/api/device-auth/{id}/approve"),
        Some(serde_json::json!({ "tenant_id": t.to_string(), "owner": "u-mallory" })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn interactive_sign_in_denied_or_stolen_link() {
    let (app, state) = sign_in_state();
    let t = create_test_tenant(&state, "sign-in-deny").await;

    let url = register_no_key(&state, 214, None).await["AuthURL"].as_str().unwrap().to_string();
    let id = url.rsplit('/').next().unwrap().to_string();

    // Another machine cannot use this link: it just gets its own
    let other = register_no_key(&state, 216, Some(&url)).await;
    assert_eq!(other["MachineAuthorized"], false);
    assert_ne!(other["AuthURL"], url);

    // A denied sign-in tells the device and registers nothing
    let (status, _) = api_call(&app, "POST", format!("/api/device-auth/{id}/deny"), None).await;
    assert_eq!(status, StatusCode::OK);
    let denied = register_no_key(&state, 214, Some(&url)).await;
    assert_eq!(denied["MachineAuthorized"], false);
    assert!(denied["Error"].as_str().unwrap().contains("refused"));
    let (_, nodes) = api_call(&app, "GET", format!("/api/tenants/{t}/nodes"), None).await;
    assert_eq!(nodes["nodes"].as_array().unwrap().len(), 0);

    // Approval for a suspended tenant is refused; the admin routes need the admin key
    let url = register_no_key(&state, 218, None).await["AuthURL"].as_str().unwrap().to_string();
    let id = url.rsplit('/').next().unwrap().to_string();
    state.store().set_tenant_suspended(t, true).await.unwrap();
    let (status, _) = api_call(
        &app,
        "POST",
        format!("/api/device-auth/{id}/approve"),
        Some(serde_json::json!({ "tenant_id": t.to_string(), "owner": "u" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let resp = app
        .clone()
        .oneshot(Request::builder().uri(format!("/api/device-auth/{id}")).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}
