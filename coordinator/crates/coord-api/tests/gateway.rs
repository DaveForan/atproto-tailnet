//! The coordinator's built-in gateway (ADR-0029, ADR-0030).
//! A published HTTPS service adds a gateway node, and permitted devices get its name and route.
//! A request reaches the application with the caller's identity.

use std::net::{Ipv4Addr, SocketAddrV4};
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use coord_api::CoordinatorState;
use coord_gateway::netstack::{Accepted, NetStack};
use coord_gateway::proxy::Certificate;
use coord_gateway::tunnel::{public_key, Devices, Tailnet};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_rustls::rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use tokio_rustls::rustls::crypto::{ring, verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use tokio_rustls::rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use tower::ServiceExt;

const ADMIN_KEY: &str = "test-admin-key-for-gateway-tests-0000";
const BASE: &str = "ts.example.com";
const SERVICES: &str = "svc.ts.example.com";

/// Test client: the certificate is the test's own, so any certificate passes.
#[derive(Debug)]
struct AnyCert(Arc<CryptoProvider>);

impl ServerCertVerifier for AnyCert {
    fn verify_server_cert(&self, _: &CertificateDer<'_>, _: &[CertificateDer<'_>], _: &ServerName<'_>, _: &[u8], _: UnixTime) -> Result<ServerCertVerified, tokio_rustls::rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(&self, m: &[u8], c: &CertificateDer<'_>, d: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, tokio_rustls::rustls::Error> {
        verify_tls12_signature(m, c, d, &self.0.signature_verification_algorithms)
    }
    fn verify_tls13_signature(&self, m: &[u8], c: &CertificateDer<'_>, d: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, tokio_rustls::rustls::Error> {
        verify_tls13_signature(m, c, d, &self.0.signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

fn setup() -> (axum::Router, Arc<CoordinatorState>) {
    let made = rcgen::generate_simple_self_signed(vec![format!("*.{SERVICES}")]).unwrap();
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(made.signing_key.serialize_der()));
    let certificate = Arc::new(Certificate::from_der(vec![made.cert.der().clone()], key).unwrap());
    let state = Arc::new(
        CoordinatorState::builder(coord_noise::generate_control_key())
            .with_admin_api_key(Some(ADMIN_KEY.to_string()))
            .with_builtin_relay_region("derp.example.com", 3478)
            .with_gateway([5; 32], certificate)
            .build(),
    );
    assert!(state.set_service_domain(SERVICES.into()));
    (coord_api::router(state.clone()), state)
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

/// A device: its WireGuard secret doubles as the seed of its machine key.
struct Device {
    secret: [u8; 32],
    machine: [u8; 32],
    id: i64,
    addr: Ipv4Addr,
}

async fn register(app: &axum::Router, state: &Arc<CoordinatorState>, tenant: &str, owner: &str, seed: u8, hostname: &str) -> Device {
    let (status, key) = call(app, "POST", "/api/preauth-keys".into(), Some(serde_json::json!({ "tenant_id": tenant, "owner": owner }))).await;
    assert_eq!(status, StatusCode::CREATED, "{key}");
    let secret = [seed; 32];
    let machine = [seed.wrapping_add(100); 32];
    let body = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode(public_key(&secret))),
        "Auth": { "AuthKey": key["key"] },
        "Hostinfo": { "Hostname": hostname, "OS": "linux" }
    });
    let out: serde_json::Value = serde_json::from_str(&coord_api::__test_handle_register(state, &machine, &body.to_string()).await.unwrap()).unwrap();
    assert_eq!(out["MachineAuthorized"], true, "{out}");
    let map = netmap(state, &Device { secret, machine, id: 0, addr: Ipv4Addr::UNSPECIFIED }).await;
    let addr = map["Node"]["Addresses"][0].as_str().unwrap().split('/').next().unwrap().parse().unwrap();
    Device { secret, machine, id: map["Node"]["ID"].as_i64().unwrap(), addr }
}

async fn netmap(state: &Arc<CoordinatorState>, d: &Device) -> serde_json::Value {
    let body = serde_json::json!({ "Version": 2, "NodeKey": format!("nodekey:{}", hex::encode(public_key(&d.secret))) });
    serde_json::from_str(&coord_api::__test_handle_map(state, &d.machine, &body.to_string()).await.unwrap()).unwrap()
}

fn peer_names(map: &serde_json::Value) -> Vec<String> {
    let mut names: Vec<String> = map["Peers"].as_array().map(|p| p.iter().map(|n| n["Hostinfo"]["Hostname"].as_str().unwrap_or("").to_string()).collect()).unwrap_or_default();
    names.sort();
    names
}

fn record(map: &serde_json::Value, name: &str) -> Option<String> {
    map["DNSConfig"]["ExtraRecords"].as_array()?.iter().find(|r| r["Name"] == name).map(|r| r["Value"].as_str().unwrap().to_string())
}

/// A device's own view of the tailnet: what it would have from its netmap.
struct Known(Vec<([u8; 32], Ipv4Addr)>);

#[async_trait::async_trait]
impl Devices for Known {
    async fn addr_of(&self, key: &[u8; 32]) -> Option<Ipv4Addr> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, a)| *a)
    }
    async fn key_of(&self, addr: Ipv4Addr) -> Option<[u8; 32]> {
        self.0.iter().find(|(_, a)| *a == addr).map(|(k, _)| *k)
    }
}

/// Bring a registered device "online": a WireGuard endpoint on the relay.
fn online(state: &Arc<CoordinatorState>, tenant: &coord_core::TenantId, d: &Device, known: &[([u8; 32], Ipv4Addr)]) -> NetStack {
    let scope = coord_derp::Scope { tenant: *tenant.as_uuid().as_bytes(), parent: None };
    let relay = state.relay().attach_local(public_key(&d.secret), scope);
    Tailnet::spawn(d.secret, d.addr, relay, Arc::new(Known(known.to_vec())))
}

async fn https_get(from: &NetStack, gateway: Ipv4Addr, name: &str, path: &str, extra_header: &str) -> Result<String, String> {
    let provider = Arc::new(ring::default_provider());
    let config = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .unwrap()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AnyCert(provider)))
        .with_no_client_auth();
    let tcp = tokio::time::timeout(Duration::from_secs(4), from.connect(SocketAddrV4::new(gateway, 443)))
        .await
        .map_err(|_| "connect timed out".to_string())?
        .map_err(|e| e.to_string())?;
    let mut tls = tokio_rustls::TlsConnector::from(Arc::new(config))
        .connect(ServerName::try_from(name.to_string()).unwrap(), tcp)
        .await
        .map_err(|e| e.to_string())?;
    tls.write_all(format!("GET {path} HTTP/1.1\r\nHost: {name}\r\nConnection: close\r\n{extra_header}\r\n").as_bytes()).await.map_err(|e| e.to_string())?;
    let mut answer = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), tls.read_to_end(&mut answer)).await;
    Ok(String::from_utf8_lossy(&answer).to_string())
}

#[tokio::test]
async fn publishing_an_https_service_brings_the_gateway_and_serves_it_with_identity() {
    let (app, state) = setup();
    let tenant = state.store().create_tenant("gw-test".into(), None, None).await.unwrap().id;
    let t = tenant.to_string();
    call(&app, "PUT", format!("/api/tenants/{t}/access"), Some(serde_json::json!({ "mode": "member" }))).await;
    call(&app, "PUT", format!("/api/tenants/{t}/identity"), Some(serde_json::json!({
        "tailnet_name": "Harbor",
        "users": { "alice": { "login_name": "alice.example.com" }, "bob": { "login_name": "bob.example.com" } }
    }))).await;
    let app_dev = register(&app, &state, &t, "alice", 21, "alice-server").await;
    let viewer = register(&app, &state, &t, "bob", 22, "bob-laptop").await;
    let outsider = register(&app, &state, &t, "carol", 23, "carol-phone").await;

    // No HTTPS service yet: no gateway
    assert_eq!(state.gateways().unwrap().running_count(), 0);
    assert_eq!(peer_names(&netmap(&state, &viewer).await), Vec::<String>::new());

    // Alice publishes food-app on port 3000 of her server, for Bob's laptop
    let dns = serde_json::json!({
        "base_domain": BASE,
        "tailnet_label": "harbor",
        "records": [{ "name": "food-app", "node": app_dev.id, "owner": "alice", "nodes": [viewer.id], "port": 3000 }]
    });
    let (status, body) = call(&app, "PUT", format!("/api/tenants/{t}/dns"), Some(dns)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(state.gateways().unwrap().running_count(), 1);

    // The gateway is a tagged node without an owner
    let (_, nodes) = call(&app, "GET", format!("/api/tenants/{t}/nodes"), None).await;
    let gw = nodes["nodes"].as_array().unwrap().iter().find(|n| n["hostname"] == "gateway").expect("a gateway node").clone();
    assert_eq!(gw["tags"], serde_json::json!(["tag:gateway"]));
    assert!(gw["owner"].is_null());

    // Bob's laptop sees the gateway and the name, which points at the gateway
    let viewer_map = netmap(&state, &viewer).await;
    assert_eq!(peer_names(&viewer_map), vec!["gateway"]);
    let gateway_peer = &viewer_map["Peers"][0];
    let gateway_addr: Ipv4Addr = gateway_peer["Addresses"][0].as_str().unwrap().split('/').next().unwrap().parse().unwrap();
    assert_eq!(record(&viewer_map, "food-app.svc.ts.example.com"), Some(gateway_addr.to_string()));
    assert!(gateway_peer["DiscoKey"].as_str().unwrap().starts_with("discokey:"), "devices need a disco key to use a peer");
    assert_eq!(gateway_peer["HomeDERP"], 1, "devices reach the gateway through the built-in relay");
    // Bob's laptop is not opened to anything by this
    assert_eq!(viewer_map["PacketFilter"], serde_json::json!([]));

    // Alice's server accepts the gateway on port 3000 only
    let app_map = netmap(&state, &app_dev).await;
    assert_eq!(peer_names(&app_map), vec!["gateway"]);
    let filter = app_map["PacketFilter"].as_array().unwrap();
    assert_eq!(filter.len(), 1, "{filter:?}");
    assert_eq!(filter[0]["SrcIPs"], serde_json::json!([format!("{gateway_addr}/32")]));
    assert_eq!(filter[0]["DstPorts"][0]["Ports"], serde_json::json!({ "First": 3000, "Last": 3000 }));
    assert_eq!(record(&app_map, "food-app.svc.ts.example.com"), Some(gateway_addr.to_string()), "the owner can open it too");

    // Carol's phone sees neither the gateway nor the name
    let outsider_map = netmap(&state, &outsider).await;
    assert_eq!(peer_names(&outsider_map), Vec::<String>::new());
    assert_eq!(record(&outsider_map, "food-app.svc.ts.example.com"), None);

    // Data path, with the three devices online
    let gateway_key: [u8; 32] = hex::decode(gateway_peer["Key"].as_str().unwrap().trim_start_matches("nodekey:")).unwrap().try_into().unwrap();
    let known = [(gateway_key, gateway_addr)];
    let app_stack = online(&state, &tenant, &app_dev, &known);
    let viewer_stack = online(&state, &tenant, &viewer, &known);
    let outsider_stack = online(&state, &tenant, &outsider, &known);
    let mut incoming = app_stack.listen(3000).await.unwrap();
    tokio::spawn(async move {
        while let Some(Accepted { mut stream, peer }) = incoming.recv().await {
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    if stream.read_exact(&mut byte).await.is_err() {
                        return;
                    }
                    head.push(byte[0]);
                }
                let head = String::from_utf8_lossy(&head).to_ascii_lowercase();
                let pick = |k: &str| head.lines().find(|l| l.starts_with(k)).unwrap_or("").to_string();
                let body = format!("from={} | {} | {}", peer.ip(), pick("x-tailnet-user:"), pick("x-tailnet-device:"));
                let _ = stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await;
            });
        }
    });

    let answer = https_get(&viewer_stack, gateway_addr, "food-app.svc.ts.example.com", "/", "X-Tailnet-User: admin.example.com\r\n").await.unwrap();
    assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
    assert!(answer.contains(&format!("from={gateway_addr}")), "{answer}");
    assert!(answer.contains("x-tailnet-user: bob.example.com"), "the identity is the caller's, not the forged one: {answer}");
    assert!(answer.contains("x-tailnet-device: bob-laptop"), "{answer}");

    // Carol knows the address and the name, but gets what an unknown name gets
    let hidden = https_get(&outsider_stack, gateway_addr, "food-app.svc.ts.example.com", "/", "").await.unwrap();
    assert!(hidden.starts_with("HTTP/1.1 404"), "{hidden}");
    let unknown = https_get(&viewer_stack, gateway_addr, "nothing.svc.ts.example.com", "/", "").await.unwrap();
    assert!(unknown.starts_with("HTTP/1.1 404"), "{unknown}");
    assert_eq!(hidden.split("\r\n\r\n").nth(1), unknown.split("\r\n\r\n").nth(1));

    // A suspended tailnet serves nothing
    call(&app, "PUT", format!("/api/tenants/{t}/suspended"), Some(serde_json::json!({ "suspended": true }))).await;
    let suspended = https_get(&viewer_stack, gateway_addr, "food-app.svc.ts.example.com", "/", "").await.unwrap();
    assert!(suspended.starts_with("HTTP/1.1 404"), "{suspended}");
}

#[tokio::test]
async fn without_a_gateway_a_service_name_resolves_to_its_device() {
    let state = Arc::new(CoordinatorState::builder(coord_noise::generate_control_key()).with_admin_api_key(Some(ADMIN_KEY.to_string())).build());
    let app = coord_api::router(state.clone());
    let tenant = state.store().create_tenant("no-gw".into(), None, None).await.unwrap().id;
    let t = tenant.to_string();
    let dev = register(&app, &state, &t, "alice", 31, "alice-server").await;
    let other = register(&app, &state, &t, "alice", 32, "alice-laptop").await;
    let dns = serde_json::json!({ "base_domain": BASE, "records": [{ "name": "notes", "node": dev.id, "owner": "alice", "port": 8080 }] });
    let (status, _) = call(&app, "PUT", format!("/api/tenants/{t}/dns"), Some(dns)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(record(&netmap(&state, &other).await, "notes.ts.example.com"), Some(dev.addr.to_string()));
    let (_, nodes) = call(&app, "GET", format!("/api/tenants/{t}/nodes"), None).await;
    assert_eq!(nodes["nodes"].as_array().unwrap().len(), 2, "no gateway node was made");
}

#[tokio::test]
async fn a_service_port_of_zero_is_refused() {
    let (app, state) = setup();
    let tenant = state.store().create_tenant("bad-port".into(), None, None).await.unwrap().id;
    let dns = serde_json::json!({ "base_domain": BASE, "records": [{ "name": "x", "node": 1, "port": 0 }] });
    let (status, _) = call(&app, "PUT", format!("/api/tenants/{tenant}/dns"), Some(dns)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn gateway_can_be_enabled_after_startup() {
    let state = Arc::new(
        CoordinatorState::builder(coord_noise::generate_control_key())
            .with_admin_api_key(Some(ADMIN_KEY.to_string()))
            .with_builtin_relay_region("derp.example.com", 3478)
            .build(),
    );
    assert!(state.gateways().is_none(), "no certificate at start: gateway off");

    assert!(state.set_service_domain(SERVICES.into()));
    let made = rcgen::generate_simple_self_signed(vec![format!("*.{SERVICES}")]).unwrap();
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(made.signing_key.serialize_der()));
    let certificate = Arc::new(Certificate::from_der(vec![made.cert.der().clone()], key).unwrap());

    assert!(state.enable_gateway([5; 32], certificate.clone()).await, "first enable turns it on");
    assert!(state.gateways().is_some());
    assert!(!state.enable_gateway([6; 32], certificate).await, "second enable is a no-op");

    let resp = tower::ServiceExt::oneshot(
        coord_api::router(state.clone()),
        Request::builder().uri("/health").body(Body::empty()).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = http_body_util::BodyExt::collect(resp.into_body()).await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["gateway"], true, "health reports the gateway once enabled");
    assert_eq!(json["service_domain"], SERVICES);
}

#[tokio::test]
async fn a_control_process_names_services_under_the_service_domain_for_a_remote_gateway() {
    let health = |state: &Arc<CoordinatorState>| {
        let app = coord_api::router(state.clone());
        async move {
            let resp = app.oneshot(Request::builder().uri("/health").body(Body::empty()).unwrap()).await.unwrap();
            let body = http_body_util::BodyExt::collect(resp.into_body()).await.unwrap().to_bytes();
            serde_json::from_slice::<serde_json::Value>(&body).unwrap()
        }
    };
    let control = Arc::new(
        CoordinatorState::builder(coord_noise::generate_control_key())
            .with_admin_api_key(Some(ADMIN_KEY.to_string()))
            .with_role(coord_api::Role::Control)
            .build(),
    );
    assert_eq!(health(&control).await["gateway"], false, "no service domain: no named services");
    assert!(control.set_service_domain(SERVICES.into()));
    assert!(!control.set_service_domain("other.example".into()), "set once");
    let json = health(&control).await;
    assert_eq!(json["gateway"], true, "the gateway runs on a relay process");
    assert_eq!(json["service_domain"], SERVICES);

    // A relay without a gateway does not claim one.
    let relay = Arc::new(CoordinatorState::builder(coord_noise::generate_control_key()).with_role(coord_api::Role::Relay).build());
    relay.set_service_domain(SERVICES.into());
    assert_eq!(health(&relay).await["gateway"], false);
}

#[tokio::test]
async fn the_gateway_relay_scope_follows_posture_suspension_and_parent() {
    let (app, state) = setup();
    let parent = state.store().create_tenant("gw-parent".into(), None, None).await.unwrap().id;
    let child = state.store().create_tenant("gw-child".into(), Some(parent), None).await.unwrap().id;
    let c = child.to_string();
    let dev = register(&app, &state, &c, "alice", 31, "alice-server").await;
    let dns = serde_json::json!({
        "base_domain": BASE,
        "records": [{ "name": "wiki", "node": dev.id, "owner": "alice", "nodes": [], "port": 8080 }]
    });
    let (status, body) = call(&app, "PUT", format!("/api/tenants/{c}/dns"), Some(dns)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(state.gateways().unwrap().running_count(), 1);
    let (_, nodes) = call(&app, "GET", format!("/api/tenants/{c}/nodes"), None).await;
    let gw_id = nodes["nodes"].as_array().unwrap().iter().find(|n| n["hostname"] == "gateway").unwrap()["id"].as_i64().unwrap();
    let gw_key: [u8; 32] = state.store().get_node_info(coord_core::NodeId::new(gw_id)).await.unwrap().info.node_key.try_into().unwrap();
    let link = || state.relay().scope_of(&gw_key).expect("gateway attached").parent;
    let p = Some(*parent.as_uuid().as_bytes());

    assert_eq!(link(), None, "a Closed child has no parent link, also for its gateway");

    let (status, _) = call(&app, "PUT", format!("/api/tenants/{c}/posture"), Some(serde_json::json!({ "posture": "open" }))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(link(), p, "opening the child links its gateway at once");

    call(&app, "PUT", format!("/api/tenants/{parent}/suspended"), Some(serde_json::json!({ "suspended": true }))).await;
    assert_eq!(link(), None, "a suspended parent loses the link");
    call(&app, "PUT", format!("/api/tenants/{parent}/suspended"), Some(serde_json::json!({ "suspended": false }))).await;
    assert_eq!(link(), p);

    let (status, _) = call(&app, "PUT", format!("/api/tenants/{c}/parent"), Some(serde_json::json!({ "parent_id": null }))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(link(), None, "a detached child has no parent");
}

// ADR-0030: a tailnet with its own ACL policy (open mode) still serves HTTPS services.
// The device of the service accepts the gateway on the published port, whatever the policy says.
#[tokio::test]
async fn an_acl_policy_does_not_block_the_gateway_from_a_published_port() {
    let (app, state) = setup();
    let tenant = state.store().create_tenant("gw-acl".into(), None, None).await.unwrap().id;
    let t = tenant.to_string();
    let app_dev = register(&app, &state, &t, "alice", 41, "alice-server").await;
    let viewer = register(&app, &state, &t, "bob", 42, "bob-laptop").await;
    // The policy opens SSH between devices and nothing else
    let policy = serde_json::json!({ "tenant_id": t, "policy": { "default_deny": false, "rules": [{ "src": "*", "dst": "*", "ports": [{ "Single": 22 }] }] } });
    let (status, body) = call(&app, "POST", "/api/acl".into(), Some(policy)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let ports_of = |map: &serde_json::Value| -> Vec<(String, u64)> {
        let mut out = Vec::new();
        for rule in map["PacketFilter"].as_array().unwrap() {
            for dst in rule["DstPorts"].as_array().unwrap() {
                out.push((rule["SrcIPs"][0].as_str().unwrap().to_string(), dst["Ports"]["First"].as_u64().unwrap()));
            }
        }
        out
    };
    assert_eq!(ports_of(&netmap(&state, &app_dev).await), vec![("*".to_string(), 22)], "before any service: the policy only");

    let dns = serde_json::json!({ "base_domain": BASE, "records": [{ "name": "wiki", "node": app_dev.id, "owner": "alice", "nodes": [viewer.id], "port": 8080 }] });
    let (status, body) = call(&app, "PUT", format!("/api/tenants/{t}/dns"), Some(dns)).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let app_map = netmap(&state, &app_dev).await;
    let gateway_peer = app_map["Peers"].as_array().unwrap().iter().find(|p| p["Hostinfo"]["Hostname"] == "gateway").expect("the gateway is a peer").clone();
    let gateway_addr = gateway_peer["Addresses"][0].as_str().unwrap().to_string();
    assert_eq!(ports_of(&app_map), vec![("*".to_string(), 22), (gateway_addr.clone(), 8080)], "the policy, plus the gateway on the published port");
    let service_rule = &app_map["PacketFilter"][1];
    assert_eq!(service_rule["IPProto"], serde_json::json!([6]), "TCP only: {service_rule}");
    // The viewer's own filter does not change: the gateway never calls a viewer
    assert_eq!(ports_of(&netmap(&state, &viewer).await), vec![("*".to_string(), 22)]);

    // Data path under the policy
    let gateway_ip: Ipv4Addr = gateway_addr.split('/').next().unwrap().parse().unwrap();
    let gateway_key: [u8; 32] = hex::decode(gateway_peer["Key"].as_str().unwrap().trim_start_matches("nodekey:")).unwrap().try_into().unwrap();
    call(&app, "PUT", format!("/api/tenants/{t}/identity"), Some(serde_json::json!({ "tailnet_name": "Acl", "users": { "bob": { "login_name": "bob.example.com" } } }))).await;
    let known = [(gateway_key, gateway_ip)];
    let app_stack = online(&state, &tenant, &app_dev, &known);
    let viewer_stack = online(&state, &tenant, &viewer, &known);
    let mut incoming = app_stack.listen(8080).await.unwrap();
    tokio::spawn(async move {
        while let Some(Accepted { mut stream, .. }) = incoming.recv().await {
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    if stream.read_exact(&mut byte).await.is_err() {
                        return;
                    }
                    head.push(byte[0]);
                }
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok").await;
            });
        }
    });
    let answer = https_get(&viewer_stack, gateway_ip, "wiki.svc.ts.example.com", "/", "").await.unwrap();
    assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
}
