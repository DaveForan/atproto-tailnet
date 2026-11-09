use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;

use coord_api::CoordinatorState;
use coord_core::ControlKey;
#[allow(unused_imports)]
use coord_federation::FederationStore;

fn setup() -> (axum::Router, Arc<CoordinatorState>) {
    let key = ControlKey::generate();
    let state = Arc::new(CoordinatorState::new(key));
    let app = coord_api::router(state.clone());
    (app, state)
}

/// Create a tenant in the store and return its ID (tests need real tenants since R6).
async fn create_test_tenant(state: &Arc<CoordinatorState>, slug: &str) -> coord_core::TenantId {
    state.store.create_tenant(slug.into(), None).await.unwrap().id
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
    let expected_mkey = format!("mkey:{}", hex::encode(state.control_key.public));
    assert_eq!(json["publicKey"], expected_mkey);
    assert_eq!(json["legacyPublicKey"], expected_mkey);
}

#[tokio::test]
async fn create_preauth_key_auto_tenant() {
    let (app, _) = setup();
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/preauth-keys")
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::CREATED);
    let body = axum::body::to_bytes(resp.into_body(), 4096)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(json["key"].as_str().unwrap().starts_with("tskey-auth-"));
    assert!(!json["tenant_id"].as_str().unwrap().is_empty());
}

#[tokio::test]
async fn register_with_preauth_key() {
    let (_, state) = setup();
    let tenant_id = create_test_tenant(&state, "register-test").await;
    let auth_key = state.store.create_preauth_key(tenant_id, false).await.unwrap();

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
    let auth_key = state.store.create_preauth_key(tenant_id, true).await.unwrap();

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
    assert_eq!(peers[0]["Name"], "node-b");
}

#[tokio::test]
async fn map_keepalive() {
    let (_, state) = setup();
    let tenant_id = create_test_tenant(&state, "map-keepalive").await;
    let auth_key = state.store.create_preauth_key(tenant_id, false).await.unwrap();
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
    assert_eq!(resp["KeepAlive"], true);
    assert!(resp["Node"].is_null());
}

#[tokio::test]
async fn tenant_isolation_in_map() {
    let (_, state) = setup();

    let t1 = create_test_tenant(&state, "iso-t1").await;
    let t2 = create_test_tenant(&state, "iso-t2").await;
    let key1 = state.store.create_preauth_key(t1, false).await.unwrap();
    let key2 = state.store.create_preauth_key(t2, false).await.unwrap();

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
    let auth_key = state.store.create_preauth_key(tenant_id, true).await.unwrap();

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

    let node2_id = state.store.get_node_by_machine_key(&mk2).await.unwrap();
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
    let auth_key = state.store.create_preauth_key(tenant_id, true).await.unwrap();

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

    let node_id = state.store.get_node_by_machine_key(&mk1).await.unwrap();
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
    let auth_key = state.store.create_preauth_key(tenant_id, true).await.unwrap();

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
    let auth_key = state.store.create_preauth_key(tenant_id, true).await.unwrap();

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

    let node_id = state.store.get_node_by_machine_key(&machine_key).await.unwrap();
    let (_, _, _, info_before) = state.store.get_node_info(node_id).await.unwrap();
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
    let (_, _, _, info_after) = state.store.get_node_info(node_id).await.unwrap();
    assert_eq!(info_after.node_key, new_node_key.to_vec());

    // Same node ID and IP should be preserved
    let same_node_id = state.store.get_node_by_machine_key(&machine_key).await.unwrap();
    assert_eq!(node_id, same_node_id);
}

#[tokio::test]
async fn map_includes_home_derp() {
    let (_, state) = setup();
    let tenant_id = create_test_tenant(&state, "home-derp").await;
    let auth_key = state.store.create_preauth_key(tenant_id, false).await.unwrap();
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
    let auth_key = state.store.create_preauth_key(tenant_id, true).await.unwrap();

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
    let auth_key = state.store.create_preauth_key(tenant_id, false).await.unwrap();
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
    state.acl.set_policy(tenant_id, policy);

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

    let key = ControlKey::generate();
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
    let auth_key = state.store.create_preauth_key(tenant_id, false).await.unwrap();
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
        Request::builder()
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
        Request::builder()
            .uri("/api/tenants")
            .body(Body::empty())
            .unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    assert!(body["count"].as_u64().unwrap() >= 1);

    // Get single tenant
    let resp = app.clone().oneshot(
        Request::builder()
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
        Request::builder()
            .method("DELETE")
            .uri(format!("/api/tenants/{}", tenant_id))
            .body(Body::empty())
            .unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // Verify deleted
    let resp = app.clone().oneshot(
        Request::builder()
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
        Request::builder()
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
        Request::builder()
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
        Request::builder()
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
        Request::builder()
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
        Request::builder()
            .method("POST")
            .uri("/api/acl")
            .header("content-type", "application/json")
            .body(Body::from(set_body.to_string()))
            .unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // Read it back via GET /api/tenants/{id}/acl
    let resp = app.clone().oneshot(
        Request::builder()
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
    let auth_key = state.store.create_preauth_key(tenant_id, true).await.unwrap();

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
    let node2_id = state.store.get_node_by_machine_key(&mk2).await.unwrap();

    // Verify both nodes appear in the peers list
    let resp = app.clone().oneshot(
        Request::builder()
            .uri(format!("/api/tenants/{}/nodes", tenant_id))
            .body(Body::empty())
            .unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    assert_eq!(body["count"].as_u64().unwrap(), 2);

    // Delete node2
    let resp = app.clone().oneshot(
        Request::builder()
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
        Request::builder()
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
    let auth_key = state.store.create_preauth_key(tenant_id, false).await.unwrap();

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

    let node_id = state.store.get_node_by_machine_key(&mk).await.unwrap();

    // Rename it
    let resp = app.clone().oneshot(
        Request::builder()
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
        Request::builder()
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
    let auth_key = state.store.create_preauth_key(tenant_id, true).await.unwrap();
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
    let parent = state.store.create_tenant("hier-parent".into(), None).await.unwrap();
    let child = state.store.create_tenant("hier-child".into(), Some(parent.id)).await.unwrap();

    // Set child posture to Open (MemoryStore: update in place)
    {
        let store = &state.store;
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
    assert_eq!(peers[0]["Name"], "child-node");
}

#[tokio::test]
async fn hierarchy_parent_blocked_when_child_closed() {
    let (_, state) = setup();

    let parent = state.store.create_tenant("closed-parent".into(), None).await.unwrap();
    let child = state.store.create_tenant("closed-child".into(), Some(parent.id)).await.unwrap();

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

    let parent = state.store.create_tenant("uni-parent".into(), None).await.unwrap();
    let child = state.store.create_tenant("uni-child".into(), Some(parent.id)).await.unwrap();

    // Set child to Open
    if let coord_store::Store::Memory(m) = state.store.as_ref() {
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

    let parent = state.store.create_tenant("sel-parent".into(), None).await.unwrap();
    let child = state.store.create_tenant("sel-child".into(), Some(parent.id)).await.unwrap();

    // Set child to Selective
    if let coord_store::Store::Memory(m) = state.store.as_ref() {
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
    assert_eq!(peers[0]["Name"], "child-sel");
}

#[tokio::test]
async fn hierarchy_routes_endpoint() {
    let (app, state) = setup();

    let parent = state.store.create_tenant("route-parent".into(), None).await.unwrap();
    let child = state.store.create_tenant("route-child".into(), Some(parent.id)).await.unwrap();

    // Set child to Open
    if let coord_store::Store::Memory(m) = state.store.as_ref() {
        let mut tenants = m.tenants_for_test().lock().unwrap();
        tenants.get_mut(&child.id).unwrap().federation_posture =
            coord_core::FederationPosture::Open;
    }

    register_node_for(&state, parent.id, [31u8; 32], 32, "rp-node").await;
    register_node_for(&state, child.id, [33u8; 32], 34, "rc-node").await;

    let resp = app.clone().oneshot(
        Request::builder()
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
    let tenant = state.store.create_tenant("posture-test".into(), None).await.unwrap();

    // Default posture should be Closed
    assert_eq!(tenant.federation_posture, coord_core::FederationPosture::Closed);

    // Update to Open via API
    let resp = app.clone().oneshot(
        Request::builder()
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
    let updated = state.store.get_tenant(tenant.id).await.unwrap();
    assert_eq!(updated.federation_posture, coord_core::FederationPosture::Open);

    // Update to Selective
    let resp = app.clone().oneshot(
        Request::builder()
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
        Request::builder()
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
    let node_a_id = state.store.get_node_by_machine_key(&[201u8; 32]).await.unwrap();

    // Register a node in tenant B
    register_node_for(&state, tenant_b, [203u8; 32], 204, "tenant-b-node").await;

    // Try to delete tenant A's node with tenant_id=B -- should get 403
    let resp = app.clone().oneshot(
        Request::builder()
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
        Request::builder()
            .uri(format!("/api/nodes/{}", node_a_id.as_i64()))
            .body(Body::empty())
            .unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // Delete tenant A's node with correct tenant_id=A -- should succeed
    let resp = app.clone().oneshot(
        Request::builder()
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
        Request::builder()
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
    let node_id = state.store.get_node_by_machine_key(&[205u8; 32]).await.unwrap();

    // Try to rename with wrong tenant -- should get 403
    let resp = app.clone().oneshot(
        Request::builder()
            .method("POST")
            .uri(format!("/api/nodes/{}/name?tenant_id={}", node_id.as_i64(), tenant_b))
            .header("content-type", "application/json")
            .body(Body::from(r#"{"name":"hijacked"}"#))
            .unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);

    // Verify name unchanged
    let resp = app.clone().oneshot(
        Request::builder()
            .uri(format!("/api/nodes/{}", node_id.as_i64()))
            .body(Body::empty())
            .unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    assert_eq!(body["hostname"], "rename-guard-node");

    // Rename with correct tenant -- should succeed
    let resp = app.clone().oneshot(
        Request::builder()
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
    let tenant = state.store.create_tenant(slug.into(), None).await.unwrap();
    let cdid = coord_core::types::CollectiveDid {
        tenant_id: tenant.id,
        did: did.to_string(),
        public_key_jwk: serde_json::json!({"kty": "OKP", "crv": "Ed25519"}),
        encrypted_private_key: "encrypted-test-key".to_string(),
        created_at: chrono::Utc::now(),
    };
    state.federation_inbound.store().create_collective_did(cdid).await.unwrap();
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
    let (app, state) = setup();
    let local_did = "did:web:local.mesh:collective:alpha";
    let remote_did = "did:web:remote.mesh:collective:beta";
    let tenant_id = register_collective_did(&state, "fed-hello", local_did).await;

    // Create an active link so the hello is accepted
    use coord_core::types::{FederationLink, LinkId, LinkDirection, LinkStatus};
    let link = FederationLink {
        id: LinkId::generate(),
        local_tenant_id: tenant_id,
        peer_did: remote_did.to_string(),
        peer_broker_url: Some("https://remote.mesh/broker".to_string()),
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
    state.federation_inbound.store().create_link(link).await.unwrap();

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
        "brokerUrl": "https://remote.mesh/broker",
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
        peer_broker_url: Some("https://remote.mesh/broker".to_string()),
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
    state.federation_inbound.store().create_link(link).await.unwrap();

    // New link request from same peer should be rejected (active link already exists)
    let link_req = serde_json::json!({
        "messageId": uuid::Uuid::new_v4().to_string(),
        "collectiveDid": remote_did,
        "brokerUrl": "https://remote.mesh/broker",
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
