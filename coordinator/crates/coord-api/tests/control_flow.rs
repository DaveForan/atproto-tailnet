use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use tower::ServiceExt;

use coord_api::CoordinatorState;
use coord_core::ControlKey;

fn setup() -> (axum::Router, Arc<CoordinatorState>) {
    let key = ControlKey::generate();
    let state = Arc::new(CoordinatorState::new(key));
    let app = coord_api::router(state.clone());
    (app, state)
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
    let tenant_id = coord_core::TenantId::generate();
    let auth_key = state.store.create_preauth_key(tenant_id, false);

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
    let tenant_id = coord_core::TenantId::generate();
    let auth_key = state.store.create_preauth_key(tenant_id, true);

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
    let tenant_id = coord_core::TenantId::generate();
    let auth_key = state.store.create_preauth_key(tenant_id, false);
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

    let t1 = coord_core::TenantId::generate();
    let t2 = coord_core::TenantId::generate();
    let key1 = state.store.create_preauth_key(t1, false);
    let key2 = state.store.create_preauth_key(t2, false);

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
    let tenant_id = coord_core::TenantId::generate();
    let auth_key = state.store.create_preauth_key(tenant_id, true);

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

    let node2_id = state.store.get_node_by_machine_key(&mk2).unwrap();
    let event = coord_store::PeerEvent::NodeJoined {
        tenant_id,
        node_id: node2_id,
    };

    let delta = coord_api::__test_build_delta(&state, &mk1, &event);
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
    let tenant_id = coord_core::TenantId::generate();
    let auth_key = state.store.create_preauth_key(tenant_id, true);

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

    let node_id = state.store.get_node_by_machine_key(&mk1).unwrap();
    let event = coord_store::PeerEvent::NodeOffline {
        tenant_id,
        node_id,
    };

    let delta = coord_api::__test_build_delta(&state, &[0u8; 32], &event);
    assert!(delta.is_some());
    let resp: serde_json::Value = serde_json::from_str(&delta.unwrap()).unwrap();
    let removed = resp["PeersRemoved"].as_array().unwrap();
    assert_eq!(removed.len(), 1);
    assert_eq!(removed[0].as_i64().unwrap(), node_id.as_i64());
}

#[tokio::test]
async fn map_with_endpoints() {
    let (_, state) = setup();
    let tenant_id = coord_core::TenantId::generate();
    let auth_key = state.store.create_preauth_key(tenant_id, true);

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
    let tenant_id = coord_core::TenantId::generate();
    let auth_key = state.store.create_preauth_key(tenant_id, true);

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

    let node_id = state.store.get_node_by_machine_key(&machine_key).unwrap();
    let (_, _, _, info_before) = state.store.get_node_info(node_id).unwrap();
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
    let (_, _, _, info_after) = state.store.get_node_info(node_id).unwrap();
    assert_eq!(info_after.node_key, new_node_key.to_vec());

    // Same node ID and IP should be preserved
    let same_node_id = state.store.get_node_by_machine_key(&machine_key).unwrap();
    assert_eq!(node_id, same_node_id);
}

#[tokio::test]
async fn map_includes_home_derp() {
    let (_, state) = setup();
    let tenant_id = coord_core::TenantId::generate();
    let auth_key = state.store.create_preauth_key(tenant_id, false);
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
    let tenant_id = coord_core::TenantId::generate();
    let auth_key = state.store.create_preauth_key(tenant_id, true);

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
    let tenant_id = coord_core::TenantId::generate();
    let auth_key = state.store.create_preauth_key(tenant_id, false);
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
    let tenant_id = coord_core::TenantId::generate();
    let auth_key = state.store.create_preauth_key(tenant_id, false);
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
