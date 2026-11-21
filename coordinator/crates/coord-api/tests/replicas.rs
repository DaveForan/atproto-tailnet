//! Two coordinator replicas on one PostgreSQL database (ADR-0034).
//! Skipped unless TEST_DATABASE_URL is set (a failure when env CI is set).

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use coord_api::CoordinatorState;
use rand::RngCore;
use tower::ServiceExt;

const ADMIN_KEY: &str = "test-admin-key-for-replica-tests";

/// TEST_DATABASE_URL, or `None` to skip. In CI (env `CI` set) a missing URL
/// is a failure, so these PostgreSQL tests cannot silently skip.
fn test_database_url() -> Option<String> {
    match std::env::var("TEST_DATABASE_URL") {
        Ok(url) if !url.is_empty() => Some(url),
        _ if std::env::var_os("CI").is_some() => {
            panic!("CI is set but TEST_DATABASE_URL is not: the PostgreSQL tests must run in CI")
        }
        _ => {
            eprintln!("NOTICE: TEST_DATABASE_URL not set; PostgreSQL test skipped");
            None
        }
    }
}

async fn replica() -> Option<(axum::Router, Arc<CoordinatorState>)> {
    let url = test_database_url()?;
    let pool = sqlx::PgPool::connect(&url).await.expect("connect to test DB");
    let store = coord_store::PgStore::new(pool).await.expect("PgStore::new");
    let state = Arc::new(
        CoordinatorState::builder(coord_noise::generate_control_key())
            .with_store(coord_store::Store::Pg(store))
            .with_admin_api_key(Some(ADMIN_KEY.to_string()))
            .with_device_auth_url(Some("https://dash.example/device".into()))
            .with_device_auth_wait(Duration::from_secs(8))
            .build(),
    );
    state.load_config().await;
    state.spawn_replica_listener();
    Some((coord_api::router(state.clone()), state))
}

async fn call(app: &axum::Router, method: &str, uri: String, body: Option<serde_json::Value>) -> (StatusCode, serde_json::Value) {
    let mut req = Request::builder().method(method).uri(uri).header("authorization", format!("Bearer {ADMIN_KEY}"));
    let body = match body {
        Some(b) => {
            req = req.header("content-type", "application/json");
            Body::from(b.to_string())
        }
        None => Body::empty(),
    };
    let resp = app.clone().oneshot(req.body(body).unwrap()).await.unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null))
}

fn random_key() -> [u8; 32] {
    let mut k = [0u8; 32];
    rand::rng().fill_bytes(&mut k);
    k
}

fn slug(prefix: &str) -> String {
    format!("{prefix}-{}", hex::encode(&random_key()[..4]))
}

/// Poll until `check` passes or 5 seconds are over.
async fn eventually<F, Fut>(what: &str, mut check: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    for _ in 0..100 {
        if check().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("never happened: {what}");
}

async fn register(state: &Arc<CoordinatorState>, mkey: &[u8; 32], auth_key: Option<&str>, followup: Option<&str>) -> serde_json::Value {
    let mut node_key = *mkey;
    node_key[0] ^= 0xff;
    let mut body = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode(node_key)),
        "Hostinfo": { "Hostname": "replica-test", "OS": "linux" }
    });
    if let Some(k) = auth_key {
        body["Auth"] = serde_json::json!({ "AuthKey": k });
    }
    if let Some(f) = followup {
        body["Followup"] = serde_json::json!(f);
    }
    serde_json::from_str(&coord_api::__test_handle_register(state, mkey, &body.to_string()).await.unwrap()).unwrap()
}

#[tokio::test]
async fn configuration_set_on_one_replica_reaches_the_other_and_survives_a_restart() {
    let Some((app_a, state_a)) = replica().await else {
        eprintln!("TEST_DATABASE_URL not set — skipping replica test");
        return;
    };
    let (app_b, _state_b) = replica().await.unwrap();
    let tenant = state_a.store().create_tenant(slug("rep-cfg"), None, None).await.unwrap().id;

    let identity = serde_json::json!({
        "tailnet_name": "Replica Net",
        "users": { "alice": { "login_name": "alice.test", "display_name": "Alice" } }
    });
    let (status, _) = call(&app_a, "PUT", format!("/api/tenants/{tenant}/identity"), Some(identity)).await;
    assert_eq!(status, StatusCode::OK);
    let approvers = serde_json::json!({ "routes": { "10.0.0.0/8": ["tag:router"] }, "exit_node": [] });
    let (status, body) = call(&app_a, "PUT", format!("/api/tenants/{tenant}/auto-approvers"), Some(approvers)).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // Replica B hears about it and reloads its cache
    eventually("identity on replica B", || async {
        let (_, got) = call(&app_b, "GET", format!("/api/tenants/{tenant}/identity"), None).await;
        got["tailnet_name"] == "Replica Net" && got["users"]["alice"]["login_name"] == "alice.test"
    })
    .await;
    eventually("auto-approvers on replica B", || async {
        let (_, got) = call(&app_b, "GET", format!("/api/tenants/{tenant}/auto-approvers"), None).await;
        got["routes"]["10.0.0.0/8"][0] == "tag:router"
    })
    .await;

    // A replica that starts later reads it from the store: no replay is needed
    let (app_c, _state_c) = replica().await.unwrap();
    let (_, got) = call(&app_c, "GET", format!("/api/tenants/{tenant}/identity"), None).await;
    assert_eq!(got["tailnet_name"], "Replica Net");
}

#[tokio::test]
async fn a_device_registered_at_one_replica_is_a_peer_at_the_other() {
    let Some((app_a, state_a)) = replica().await else { return };
    let (_app_b, state_b) = replica().await.unwrap();
    let tenant = state_a.store().create_tenant(slug("rep-peer"), None, None).await.unwrap().id;
    let (status, key) = call(&app_a, "POST", "/api/preauth-keys".into(), Some(serde_json::json!({ "tenant_id": tenant.to_string(), "reusable": true }))).await;
    assert_eq!(status, StatusCode::CREATED, "{key}");
    let key = key["key"].as_str().unwrap();

    let (one, two) = (random_key(), random_key());
    assert_eq!(register(&state_a, &one, Some(key), None).await["MachineAuthorized"], true);

    // Replica B waits for peer events while the second device registers at A
    let mut events = state_b.store().subscribe();
    assert_eq!(register(&state_a, &two, Some(key), None).await["MachineAuthorized"], true);
    let joined = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(coord_store::PeerEvent::NodeJoined { tenant_id, .. }) = events.recv().await
                && tenant_id == tenant {
                    return;
                }
        }
    })
    .await;
    assert!(joined.is_ok(), "replica B never saw the join event");

    // The netmap that B builds for device one contains device two
    let mut node_key = one;
    node_key[0] ^= 0xff;
    let body = serde_json::json!({ "Version": 2, "NodeKey": format!("nodekey:{}", hex::encode(node_key)) });
    let map: serde_json::Value =
        serde_json::from_str(&coord_api::__test_handle_map(&state_b, &one, &body.to_string()).await.unwrap()).unwrap();
    assert_eq!(map["Peers"].as_array().map(|p| p.len()), Some(1), "{map}");
}

#[tokio::test]
async fn a_sign_in_started_at_one_replica_is_approved_at_another_and_finished_at_a_third() {
    let Some((_app_a, state_a)) = replica().await else { return };
    let (app_b, _state_b) = replica().await.unwrap();
    let (_app_c, state_c) = replica().await.unwrap();
    let tenant = state_a.store().create_tenant(slug("rep-signin"), None, None).await.unwrap().id;
    let machine = random_key();

    // The device asks replica A and gets a sign-in URL
    let first = register(&state_a, &machine, None, None).await;
    let url = first["AuthURL"].as_str().unwrap().to_string();
    assert!(url.starts_with("https://dash.example/device/"), "{first}");
    let id = url.rsplit('/').next().unwrap().to_string();

    // Its follow-up request waits at replica C
    let waiter = {
        let (state_c, url) = (state_c.clone(), url.clone());
        tokio::spawn(async move { register(&state_c, &machine, None, Some(&url)).await })
    };
    tokio::time::sleep(Duration::from_millis(200)).await;

    // The dashboard approves through replica B
    let (status, seen) = call(&app_b, "GET", format!("/api/device-auth/{id}"), None).await;
    assert_eq!((status, &seen["pending"]), (StatusCode::OK, &serde_json::json!(true)), "{seen}");
    let started = std::time::Instant::now();
    let (status, _) = call(&app_b, "POST", format!("/api/device-auth/{id}/approve"), Some(serde_json::json!({ "tenant_id": tenant.to_string(), "owner": "alice" }))).await;
    assert_eq!(status, StatusCode::OK);
    // A second answer is refused on any replica
    let (status, _) = call(&_app_a, "POST", format!("/api/device-auth/{id}/deny"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let done = tokio::time::timeout(Duration::from_secs(6), waiter).await.expect("the waiting device was never answered").unwrap();
    assert_eq!(done["MachineAuthorized"], true, "{done}");
    assert!(started.elapsed() < Duration::from_secs(4), "took {:?}", started.elapsed());
}

/// A process of one role on the shared database. `gateway` = it holds a gateway certificate.
async fn process(role: coord_api::Role, gateway: bool) -> Option<Arc<CoordinatorState>> {
    let url = test_database_url()?;
    let pool = sqlx::PgPool::connect(&url).await.expect("connect to test DB");
    let store = coord_store::PgStore::new(pool).await.expect("PgStore::new");
    let mut builder = CoordinatorState::builder(coord_noise::generate_control_key())
        .with_store(coord_store::Store::Pg(store))
        .with_role(role)
        .with_admin_api_key(Some(ADMIN_KEY.to_string()))
        .with_builtin_relay_region("derp.example.com", 3478);
    if gateway {
        let made = rcgen::generate_simple_self_signed(vec!["*.svc.ts.example.com".to_string()]).unwrap();
        let key = tokio_rustls::rustls::pki_types::PrivateKeyDer::Pkcs8(made.signing_key.serialize_der().into());
        let certificate = Arc::new(coord_gateway::proxy::Certificate::from_der(vec![made.cert.der().clone()], key).unwrap());
        builder = builder.with_gateway([9; 32], certificate);
    }
    let state = Arc::new(builder.build());
    assert!(state.set_service_domain("svc.ts.example.com".into()));
    state.load_config().await;
    state.spawn_replica_listener();
    Some(state)
}

async fn gateway_nodes(state: &Arc<CoordinatorState>, tenant: coord_core::TenantId) -> Vec<coord_core::NodeSummary> {
    let nodes = state.store().list_nodes_for_tenant(tenant).await;
    nodes.into_iter().filter(|n| n.attrs.tags.iter().any(|t| t == coord_core::GATEWAY_TAG)).collect()
}

// ADR-0038: the relay holds the gateway secret but never writes a node.
// It offers public keys; the control process registers the node from them.
#[tokio::test]
async fn a_relay_offers_its_gateway_and_the_control_process_registers_the_node() {
    let Some(control) = process(coord_api::Role::Control, false).await else { return };
    let relay = process(coord_api::Role::Relay, true).await.unwrap();
    let app = coord_api::router(control.clone());
    let tenant = control.store().create_tenant(slug("gw-split"), None, None).await.unwrap().id;
    let key = call(&app, "POST", "/api/preauth-keys".into(), Some(serde_json::json!({ "tenant_id": tenant.to_string(), "owner": "alice" }))).await.1;
    let machine = random_key();
    let out = register(&control, &machine, key["key"].as_str(), None).await;
    assert_eq!(out["MachineAuthorized"], true, "{out}");
    let device = control.store().get_node_by_machine_key(&machine).await.unwrap();

    let dns = serde_json::json!({ "base_domain": "ts.example.com", "records": [{ "name": "wiki", "node": device.as_i64(), "owner": "alice", "port": 8080 }] });
    let (status, body) = call(&app, "PUT", format!("/api/tenants/{tenant}/dns"), Some(dns)).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    eventually("the relay runs the gateway of the tenant", || async { relay.gateways().unwrap().running_count() >= 1 }).await;
    let gateways = gateway_nodes(&control, tenant).await;
    assert_eq!(gateways.len(), 1, "one gateway node, registered by the control process");
    assert!(gateways[0].attrs.owner.is_none());
    let offer = control.store().get_gateway_offer(tenant).await.expect("the relay stored its offer");
    assert_eq!(control.store().get_node_by_node_key(&offer.node_key).await, Some(gateways[0].id));
    control.store().delete_tenant(tenant).await.unwrap();
}

#[tokio::test]
async fn a_gateway_offer_with_the_keys_of_a_device_is_refused() {
    let Some(control) = process(coord_api::Role::Control, false).await else { return };
    let app = coord_api::router(control.clone());
    let tenant = control.store().create_tenant(slug("gw-forged"), None, None).await.unwrap().id;
    let key = call(&app, "POST", "/api/preauth-keys".into(), Some(serde_json::json!({ "tenant_id": tenant.to_string(), "owner": "alice" }))).await.1;
    let machine = random_key();
    register(&control, &machine, key["key"].as_str(), None).await;
    let device = control.store().get_node_by_machine_key(&machine).await.unwrap();

    // A compromised relay offers the machine key of Alice's device as its gateway.
    let forged = coord_core::GatewayOffer { node_key: random_key(), machine_key: machine, disco_key: random_key(), region_id: 1 };
    control.store().offer_gateway(tenant, &forged).await.unwrap();
    let dns = serde_json::json!({ "base_domain": "ts.example.com", "records": [{ "name": "wiki", "node": device.as_i64(), "owner": "alice", "port": 8080 }] });
    let (status, _) = call(&app, "PUT", format!("/api/tenants/{tenant}/dns"), Some(dns)).await;
    assert_eq!(status, StatusCode::OK);

    assert!(gateway_nodes(&control, tenant).await.is_empty(), "no gateway node from a forged offer");
    let nodes = control.store().list_nodes_for_tenant(tenant).await;
    assert_eq!(nodes.len(), 1);
    assert_eq!(nodes[0].attrs.owner.as_deref(), Some("alice"), "Alice's device is untouched");
    control.store().delete_tenant(tenant).await.unwrap();
}
