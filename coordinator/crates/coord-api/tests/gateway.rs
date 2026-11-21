//! The coordinator's built-in gateway (ADR-0029, ADR-0030).
//! A published HTTPS service adds a gateway node, and permitted devices get its name and route.
//! A request reaches the application with the caller's identity.

use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use boringtun::noise::{Tunn, TunnResult};
use boringtun::x25519::{PublicKey as X25519Public, StaticSecret};
use coord_api::CoordinatorState;
use coord_gateway::direct::DirectSocket;
use coord_gateway::netstack::{Accepted, NetStack};
use coord_gateway::proxy::Certificate;
use coord_gateway::tunnel::{public_key, Devices, Tailnet};
use crypto_box::aead::Aead;
use crypto_box::{PublicKey, SalsaBox, SecretKey};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UdpSocket;
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

fn certificate() -> Arc<Certificate> {
    let made = rcgen::generate_simple_self_signed(vec![format!("*.{SERVICES}")]).unwrap();
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(made.signing_key.serialize_der()));
    Arc::new(Certificate::from_der(vec![made.cert.der().clone()], key).unwrap())
}

fn setup() -> (axum::Router, Arc<CoordinatorState>) {
    let state = Arc::new(
        CoordinatorState::builder(coord_noise::generate_control_key())
            .with_admin_api_key(Some(ADMIN_KEY.to_string()))
            .with_builtin_relay_region("derp.example.com", 3478)
            .with_gateway([5; 32], certificate())
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

// ---- Direct paths (ADR-0029 phase 2) ----

const DISCO_MAGIC: &[u8] = b"TS\xf0\x9f\x92\xac";

async fn setup_direct() -> (axum::Router, Arc<CoordinatorState>, SocketAddr) {
    let socket = DirectSocket::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
    let udp = socket.local_addr().unwrap();
    let state = Arc::new(
        CoordinatorState::builder(coord_noise::generate_control_key())
            .with_admin_api_key(Some(ADMIN_KEY.to_string()))
            .with_builtin_relay_region("derp.example.com", 3478)
            .with_gateway([5; 32], certificate())
            .with_gateway_direct(socket, vec![udp])
            .build(),
    );
    assert!(state.set_service_domain(SERVICES.into()));
    (coord_api::router(state.clone()), state, udp)
}

/// The disco side of a test device. It makes the NaCl boxes itself, not with the gateway's code.
struct Disco {
    secret: SecretKey,
    gateway: PublicKey,
}

impl Disco {
    fn public(&self) -> [u8; 32] {
        self.secret.public_key().to_bytes()
    }

    fn packet(&self, plain: &[u8]) -> Vec<u8> {
        let nonce: [u8; 24] = rand::random();
        let sealed = SalsaBox::new(&self.gateway, &self.secret).encrypt(crypto_box::Nonce::from_slice(&nonce), plain).unwrap();
        [DISCO_MAGIC, &self.public(), &nonce, &sealed].concat()
    }

    fn ping(&self, tx: [u8; 12], node_key: Option<[u8; 32]>) -> Vec<u8> {
        let mut plain = vec![1, 0];
        plain.extend_from_slice(&tx);
        plain.extend_from_slice(node_key.as_ref().map(|k| &k[..]).unwrap_or_default());
        self.packet(&plain)
    }

    /// The transaction id and the source address in a pong from the gateway.
    fn pong(&self, packet: &[u8]) -> Option<([u8; 12], SocketAddr)> {
        let rest = packet.strip_prefix(DISCO_MAGIC)?;
        if rest.len() < 56 || rest[..32] != self.gateway.to_bytes() {
            return None;
        }
        let plain = SalsaBox::new(&self.gateway, &self.secret).decrypt(crypto_box::Nonce::from_slice(&rest[32..56]), &rest[56..]).ok()?;
        if plain.len() != 2 + 12 + 18 || plain[..2] != [2, 0] {
            return None;
        }
        let ip = std::net::Ipv6Addr::from(<[u8; 16]>::try_from(&plain[14..30]).unwrap());
        let port = u16::from_be_bytes([plain[30], plain[31]]);
        Some((plain[2..14].try_into().unwrap(), SocketAddr::new(std::net::IpAddr::V6(ip).to_canonical(), port)))
    }
}

/// A tailnet with Alice's server behind `food-app`, Bob's laptop as a viewer, and a running gateway.
struct DirectTailnet {
    tenant: coord_core::TenantId,
    app_dev: Device,
    viewer: Device,
    disco: Disco,
    gateway_key: [u8; 32],
    gateway_addr: Ipv4Addr,
    viewer_map: serde_json::Value,
}

fn key_in(value: &serde_json::Value, prefix: &str) -> [u8; 32] {
    hex::decode(value.as_str().unwrap().trim_start_matches(prefix)).unwrap().try_into().unwrap()
}

async fn announce_disco(state: &Arc<CoordinatorState>, d: &Device, disco: [u8; 32]) {
    let body = serde_json::json!({
        "Version": 2,
        "NodeKey": format!("nodekey:{}", hex::encode(public_key(&d.secret))),
        "DiscoKey": format!("discokey:{}", hex::encode(disco)),
    });
    coord_api::__test_handle_map(state, &d.machine, &body.to_string()).await.unwrap();
}

async fn tailnet_with_service(app: &axum::Router, state: &Arc<CoordinatorState>, slug: &str, seed: u8) -> DirectTailnet {
    let tenant = state.store().create_tenant(slug.into(), None, None).await.unwrap().id;
    let t = tenant.to_string();
    call(app, "PUT", format!("/api/tenants/{t}/access"), Some(serde_json::json!({ "mode": "member" }))).await;
    call(app, "PUT", format!("/api/tenants/{t}/identity"), Some(serde_json::json!({
        "users": { "alice": { "login_name": "alice.example.com" }, "bob": { "login_name": "bob.example.com" } }
    }))).await;
    let app_dev = register(app, state, &t, "alice", seed, "alice-server").await;
    let viewer = register(app, state, &t, "bob", seed + 1, "bob-laptop").await;
    let dns = serde_json::json!({
        "base_domain": BASE,
        "records": [{ "name": "food-app", "node": app_dev.id, "owner": "alice", "nodes": [viewer.id], "port": 3000 }]
    });
    let (status, body) = call(app, "PUT", format!("/api/tenants/{t}/dns"), Some(dns)).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let viewer_map = netmap(state, &viewer).await;
    let peer = &viewer_map["Peers"][0];
    assert_eq!(peer["Hostinfo"]["Hostname"], "gateway");
    let disco = Disco { secret: SecretKey::from_bytes([seed + 100; 32]), gateway: PublicKey::from_bytes(key_in(&peer["DiscoKey"], "discokey:")) };
    // The gateway already runs: the new disco key must reach it as a change.
    announce_disco(state, &viewer, disco.public()).await;
    DirectTailnet {
        tenant,
        gateway_key: key_in(&peer["Key"], "nodekey:"),
        gateway_addr: peer["Addresses"][0].as_str().unwrap().split('/').next().unwrap().parse().unwrap(),
        app_dev,
        viewer,
        disco,
        viewer_map,
    }
}

async fn datagram(socket: &UdpSocket, wait: Duration) -> Option<Vec<u8>> {
    let mut buf = [0u8; 2048];
    let (len, _) = tokio::time::timeout(wait, socket.recv_from(&mut buf)).await.ok()?.ok()?;
    Some(buf[..len].to_vec())
}

/// Pings until the gateway answers: it reads the disco keys of the tailnet a moment after a change.
async fn ping_until_pong(socket: &UdpSocket, to: SocketAddr, disco: &Disco, node_key: [u8; 32]) -> ([u8; 12], SocketAddr, usize, usize) {
    for attempt in 0..40u8 {
        let tx = [attempt; 12];
        let ping = disco.ping(tx, Some(node_key));
        socket.send_to(&ping, to).await.unwrap();
        if let Some(packet) = datagram(socket, Duration::from_millis(100)).await {
            let (pong_tx, src) = disco.pong(&packet).expect("the answer to a ping is a pong for the device");
            assert_eq!(pong_tx, tx, "the pong repeats the transaction id of the ping");
            return (pong_tx, src, ping.len(), packet.len());
        }
    }
    panic!("the gateway did not answer a valid ping");
}

/// A device with WireGuard on a UDP socket only: it has no relay connection.
/// A socket sent to the returned channel replaces the first one, as when the device moves to another network.
fn direct_device(d: &Device, gateway_key: [u8; 32], gateway_udp: SocketAddr, mut socket: Arc<UdpSocket>) -> (NetStack, tokio::sync::mpsc::Sender<Arc<UdpSocket>>) {
    let (out, mut out_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(256);
    let (roam, mut roamed) = tokio::sync::mpsc::channel::<Arc<UdpSocket>>(1);
    let stack = NetStack::spawn(d.addr, out);
    let inject = stack.clone();
    let mut tunn = Tunn::new(StaticSecret::from(d.secret), X25519Public::from(gateway_key), None, None, 7, None);
    tokio::spawn(async move {
        let (mut wire, mut plain) = (vec![0u8; 2048], vec![0u8; 2048]);
        let mut tick = tokio::time::interval(Duration::from_millis(100));
        loop {
            tokio::select! {
                Some(new) = roamed.recv() => socket = new,
                packet = out_rx.recv() => {
                    let Some(packet) = packet else { return };
                    if let TunnResult::WriteToNetwork(data) = tunn.encapsulate(&packet, &mut plain) {
                        let _ = socket.send_to(data, gateway_udp).await;
                    }
                }
                received = socket.recv_from(&mut wire) => {
                    let Ok((len, from)) = received else { return };
                    assert_eq!(from, gateway_udp, "the gateway answers from the socket it advertises");
                    let mut input = &wire[..len];
                    loop {
                        match tunn.decapsulate(None, input, &mut plain) {
                            TunnResult::WriteToNetwork(data) => {
                                let _ = socket.send_to(data, gateway_udp).await;
                                input = &[];
                                continue;
                            }
                            TunnResult::WriteToTunnelV4(packet, _) => inject.inject(packet.to_vec()),
                            _ => {}
                        }
                        break;
                    }
                }
                _ = tick.tick() => {
                    if let TunnResult::WriteToNetwork(data) = tunn.update_timers(&mut plain) {
                        let _ = socket.send_to(data, gateway_udp).await;
                    }
                }
            }
        }
    });
    (stack, roam)
}

/// Alice's application: it answers each request with the gateway's identity headers.
async fn serve_app(stack: &NetStack) {
    let mut incoming = stack.listen(3000).await.unwrap();
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
                let head = String::from_utf8_lossy(&head).to_ascii_lowercase();
                let body = head.lines().find(|l| l.starts_with("x-tailnet-user:")).unwrap_or("").to_string();
                let _ = stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await;
            });
        }
    });
}

#[tokio::test]
async fn a_device_reaches_the_gateway_on_a_direct_udp_path() {
    let (app, state, gateway_udp) = setup_direct().await;
    let net = tailnet_with_service(&app, &state, "gw-direct", 41).await;
    assert_eq!(net.viewer_map["Peers"][0]["Endpoints"], serde_json::json!([gateway_udp.to_string()]), "devices learn where to ping the gateway");

    // The application is on the relay. The viewer has a UDP socket and nothing else.
    let app_stack = online(&state, &net.tenant, &net.app_dev, &[(net.gateway_key, net.gateway_addr)]);
    serve_app(&app_stack).await;
    let socket = Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap());
    let viewer_key = public_key(&net.viewer.secret);

    let (_, src, ping_len, pong_len) = ping_until_pong(&socket, gateway_udp, &net.disco, viewer_key).await;
    assert_eq!(src, socket.local_addr().unwrap(), "the pong tells the device its address as the gateway sees it");
    assert!(pong_len <= ping_len, "a pong is never longer than its ping");

    let (viewer_stack, roam) = direct_device(&net.viewer, net.gateway_key, gateway_udp, socket);
    let answer = https_get(&viewer_stack, net.gateway_addr, "food-app.svc.ts.example.com", "/", "").await.unwrap();
    assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
    assert!(answer.contains("x-tailnet-user: bob.example.com"), "{answer}");

    // The device moves to another address and sends no ping there.
    // The session index finds the gateway, and the answers follow the new address.
    roam.send(Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap())).await.unwrap();
    let answer = https_get(&viewer_stack, net.gateway_addr, "food-app.svc.ts.example.com", "/", "").await.unwrap();
    assert!(answer.starts_with("HTTP/1.1 200"), "after the move: {answer}");
    assert!(state.relay().scope_of(&viewer_key).is_none(), "the viewer never was on the relay: the handshake and the data used UDP");
}

#[tokio::test]
async fn the_gateway_answers_only_pings_that_a_device_of_its_tailnet_proves() {
    let (app, state, gateway_udp) = setup_direct().await;
    let net = tailnet_with_service(&app, &state, "gw-direct-a", 51).await;
    let other = tailnet_with_service(&app, &state, "gw-direct-b", 61).await;
    let viewer_key = public_key(&net.viewer.secret);
    let socket = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let silent = Duration::from_millis(300);

    // A disco key that no device has. This socket never sent a valid ping.
    let stranger = Disco { secret: SecretKey::from_bytes([9; 32]), gateway: net.disco.gateway.clone() };
    socket.send_to(&stranger.ping([1; 12], Some(viewer_key)), gateway_udp).await.unwrap();
    assert!(datagram(&socket, silent).await.is_none(), "an unknown disco key gets no answer");

    // A WireGuard handshake from an address that proved nothing.
    let mut tunn = Tunn::new(StaticSecret::from(net.viewer.secret), X25519Public::from(net.gateway_key), None, None, 9, None);
    let mut buf = [0u8; 256];
    let TunnResult::WriteToNetwork(initiation) = tunn.format_handshake_initiation(&mut buf, false) else { panic!("no initiation") };
    assert_eq!(initiation.len(), 148);
    socket.send_to(initiation, gateway_udp).await.unwrap();
    assert!(datagram(&socket, silent).await.is_none(), "a handshake needs a valid ping from the same address first");

    // Both gateways run and answer their own devices.
    ping_until_pong(&socket, gateway_udp, &net.disco, viewer_key).await;
    let other_socket = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    ping_until_pong(&other_socket, gateway_udp, &other.disco, public_key(&other.viewer.secret)).await;

    // A device of another tailnet: its disco key is known to the socket, but not to this gateway.
    let crossing = Disco { secret: other.disco.secret.clone(), gateway: net.disco.gateway.clone() };
    socket.send_to(&crossing.ping([2; 12], Some(public_key(&other.viewer.secret))), gateway_udp).await.unwrap();
    socket.send_to(&crossing.ping([3; 12], Some(viewer_key)), gateway_udp).await.unwrap();
    assert!(datagram(&socket, silent).await.is_none(), "a device of another tailnet gets no answer");

    // The right disco key, but no node key, or the node key of another device.
    socket.send_to(&net.disco.ping([4; 12], None), gateway_udp).await.unwrap();
    socket.send_to(&net.disco.ping([5; 12], Some(public_key(&net.app_dev.secret))), gateway_udp).await.unwrap();
    assert!(datagram(&socket, silent).await.is_none(), "a UDP ping must name the node of its disco key");

    // A changed box.
    let mut changed = net.disco.ping([6; 12], Some(viewer_key));
    *changed.last_mut().unwrap() ^= 1;
    socket.send_to(&changed, gateway_udp).await.unwrap();
    assert!(datagram(&socket, silent).await.is_none());

    // A removed device gets no answer, at once.
    state.store().delete_node(coord_core::NodeId::new(net.viewer.id)).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    socket.send_to(&net.disco.ping([7; 12], Some(viewer_key)), gateway_udp).await.unwrap();
    assert!(datagram(&socket, silent).await.is_none(), "a removed device gets no pong");
}

#[tokio::test]
async fn a_ping_through_the_relay_gets_its_pong_through_the_relay() {
    let (app, state, _) = setup_direct().await;
    let net = tailnet_with_service(&app, &state, "gw-direct-relay", 71).await;
    let scope = coord_derp::Scope { tenant: *net.tenant.as_uuid().as_bytes(), parent: None };
    let relay = state.relay().attach_local(public_key(&net.viewer.secret), scope);
    for attempt in 0..40u8 {
        // No node key: the relay already proved it.
        relay.send(net.gateway_key, net.disco.ping([attempt; 12], None).into());
        if let Ok(Some((from, packet))) = tokio::time::timeout(Duration::from_millis(100), relay.recv()).await {
            assert_eq!(from, net.gateway_key);
            let (tx, src) = net.disco.pong(&packet).expect("a pong");
            assert_eq!(tx, [attempt; 12]);
            assert_eq!(src, "127.3.3.40:1".parse().unwrap(), "the source is the relay address that clients use for region 1");
            return;
        }
    }
    panic!("no pong through the relay");
}

#[tokio::test]
async fn without_direct_paths_the_gateway_has_no_endpoint_and_ignores_disco() {
    let (app, state) = setup();
    let net = tailnet_with_service(&app, &state, "gw-relay-only", 81).await;
    let endpoints = &net.viewer_map["Peers"][0]["Endpoints"];
    assert!(endpoints.as_array().is_none_or(|e| e.is_empty()), "{endpoints}");
    assert_eq!(state.store().get_gateway_offer(net.tenant).await.unwrap().endpoints, vec![]);

    let scope = coord_derp::Scope { tenant: *net.tenant.as_uuid().as_bytes(), parent: None };
    let relay = state.relay().attach_local(public_key(&net.viewer.secret), scope);
    for attempt in 0..5u8 {
        relay.send(net.gateway_key, net.disco.ping([attempt; 12], Some(public_key(&net.viewer.secret))).into());
        assert!(tokio::time::timeout(Duration::from_millis(100), relay.recv()).await.is_err(), "the gateway is silent on disco");
    }
}

#[tokio::test]
async fn the_gateway_node_follows_the_endpoints_of_its_offer() {
    let (app, state, gateway_udp) = setup_direct().await;
    let net = tailnet_with_service(&app, &state, "gw-direct-offer", 91).await;
    let offer = state.store().get_gateway_offer(net.tenant).await.unwrap();
    assert_eq!(offer.endpoints, vec![gateway_udp]);

    // The relay comes back with another public address: the node gets it, and keeps its id and address.
    let moved: SocketAddr = "203.0.113.7:41641".parse().unwrap();
    state.store().offer_gateway(net.tenant, &coord_core::GatewayOffer { endpoints: vec![moved], ..offer }).await.unwrap();
    state.sync_gateway(net.tenant).await;
    let peer = netmap(&state, &net.viewer).await["Peers"][0].clone();
    assert_eq!(peer["Endpoints"], serde_json::json!([moved.to_string()]));
    assert_eq!(peer["ID"], net.viewer_map["Peers"][0]["ID"]);
    assert_eq!(peer["Addresses"], net.viewer_map["Peers"][0]["Addresses"]);
    assert_eq!(state.gateways().unwrap().running_count(), 1);
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
    // Alice put her devices under the tenant's policy. Bob did not.
    call(&app, "PUT", format!("/api/tenants/{t}/access"), Some(serde_json::json!({ "mode": "open", "open_owners": ["alice"] }))).await;
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
    // The viewer did not choose the policy and nothing calls a viewer: it accepts nothing
    assert_eq!(ports_of(&netmap(&state, &viewer).await), vec![]);

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
