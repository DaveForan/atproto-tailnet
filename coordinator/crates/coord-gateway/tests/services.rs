//! Named HTTPS services, end to end (ADR-0029, ADR-0030): a viewer device
//! opens `https://food-app.ts.example.com`; the gateway ends TLS, finds the
//! service and passes the request to an application on another device. All
//! traffic runs through WireGuard and the relay, as with real devices.

use std::net::{Ipv4Addr, SocketAddrV4};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use coord_derp::{AllowAll, DerpConfig, DerpServer, Scope};
use coord_gateway::netstack::{Accepted, NetStack};
use coord_gateway::proxy::{self, Certificate, Route, Services};
use coord_gateway::tunnel::{public_key, Devices, Tailnet};
use http::{Request, Response, StatusCode};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_rustls::rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use tokio_rustls::rustls::crypto::{ring, verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use tokio_rustls::rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use tokio_rustls::TlsConnector;

const GATEWAY: Ipv4Addr = Ipv4Addr::new(100, 64, 0, 1);
const APP_DEVICE: Ipv4Addr = Ipv4Addr::new(100, 64, 0, 2);
const VIEWER: Ipv4Addr = Ipv4Addr::new(100, 64, 0, 3);
const OUTSIDER: Ipv4Addr = Ipv4Addr::new(100, 64, 0, 4);

struct Fixed(Vec<([u8; 32], Ipv4Addr)>);

#[async_trait::async_trait]
impl Devices for Fixed {
    async fn addr_of(&self, key: &[u8; 32]) -> Option<Ipv4Addr> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, a)| *a)
    }
    async fn key_of(&self, addr: Ipv4Addr) -> Option<[u8; 32]> {
        self.0.iter().find(|(_, a)| *a == addr).map(|(k, _)| *k)
    }
}

/// One service, `food-app`, on port 3000 of the app device, for the viewer only.
struct OneService;

#[async_trait::async_trait]
impl Services for OneService {
    async fn route(&self, server_name: &str, caller: Ipv4Addr) -> Option<Route> {
        let port = match server_name {
            "food-app.ts.example.com" => 3000,
            "chat.ts.example.com" => 3001,
            _ => return None,
        };
        (caller == VIEWER).then(|| Route {
            target: SocketAddrV4::new(APP_DEVICE, port),
            user: "alice.example.com".into(),
            device: "alice-phone".into(),
        })
    }
}

/// Trusts exactly one certificate (the test's own).
#[derive(Debug)]
struct Pinned(CertificateDer<'static>, Arc<CryptoProvider>);

impl ServerCertVerifier for Pinned {
    fn verify_server_cert(&self, end_entity: &CertificateDer<'_>, _: &[CertificateDer<'_>], _: &ServerName<'_>, _: &[u8], _: UnixTime) -> Result<ServerCertVerified, tokio_rustls::rustls::Error> {
        if end_entity.as_ref() == self.0.as_ref() {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(tokio_rustls::rustls::Error::General("not the pinned certificate".into()))
        }
    }
    fn verify_tls12_signature(&self, m: &[u8], c: &CertificateDer<'_>, d: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, tokio_rustls::rustls::Error> {
        verify_tls12_signature(m, c, d, &self.1.signature_verification_algorithms)
    }
    fn verify_tls13_signature(&self, m: &[u8], c: &CertificateDer<'_>, d: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, tokio_rustls::rustls::Error> {
        verify_tls13_signature(m, c, d, &self.1.signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.1.signature_verification_algorithms.supported_schemes()
    }
}

struct World {
    viewer: NetStack,
    outsider: NetStack,
    connector: TlsConnector,
    /// Requests the application received: (method, path, headers of interest, body)
    seen: Arc<Mutex<Vec<(String, String, Vec<(String, String)>, Vec<u8>)>>>,
}

async fn world() -> World {
    let relay = Arc::new(DerpServer::new([9; 32], Arc::new(AllowAll), DerpConfig::default()));
    let scope = || Scope { tenant: [1; 16], parent: None };
    let secrets: [[u8; 32]; 4] = [[11; 32], [22; 32], [33; 32], [44; 32]];
    let addrs = [GATEWAY, APP_DEVICE, VIEWER, OUTSIDER];
    let devices = Arc::new(Fixed(secrets.iter().zip(addrs).map(|(s, a)| (public_key(s), a)).collect()));
    let mut stacks = Vec::new();
    for (secret, addr) in secrets.iter().zip(addrs) {
        stacks.push(Tailnet::spawn(*secret, addr, relay.attach_local(public_key(secret), scope()), devices.clone()));
    }
    let (gateway, app_device, viewer, outsider) = (stacks.remove(0), stacks.remove(0), stacks.remove(0), stacks.remove(0));

    // The gateway's certificate for *.ts.example.com
    let made = rcgen::generate_simple_self_signed(vec!["*.ts.example.com".to_string()]).unwrap();
    let cert_der = made.cert.der().clone();
    let key_der = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(made.signing_key.serialize_der()));
    let certificate = Arc::new(Certificate::from_der(vec![cert_der.clone()], key_der).unwrap());
    tokio::spawn(proxy::serve(gateway, certificate, Arc::new(OneService)));

    // The application on the app device: answers with what it saw
    let seen = Arc::new(Mutex::new(Vec::new()));
    let mut incoming = app_device.listen(3000).await.unwrap();
    let seen_by_app = seen.clone();
    tokio::spawn(async move {
        while let Some(Accepted { stream, peer }) = incoming.recv().await {
            assert_eq!(*peer.ip(), GATEWAY, "the application is reached by the gateway only");
            let seen = seen_by_app.clone();
            tokio::spawn(async move {
                let service = service_fn(move |req: Request<Incoming>| {
                    let seen = seen.clone();
                    async move {
                        let (parts, body) = req.into_parts();
                        let body = body.collect().await.unwrap().to_bytes().to_vec();
                        let headers = parts.headers.iter().map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string())).collect();
                        seen.lock().unwrap().push((parts.method.to_string(), parts.uri.to_string(), headers, body.clone()));
                        if parts.headers.get("upgrade").is_some() {
                            return Ok::<_, hyper::Error>(Response::builder().status(200).body(Full::new(Bytes::from_static(b"no upgrade here"))).unwrap());
                        }
                        Ok(Response::builder().status(200).header("x-app", "food").body(Full::new(Bytes::from(format!("hello from food-app, {} bytes", body.len())))).unwrap())
                    }
                });
                let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), service).await;
            });
        }
    });

    // A second application that switches protocols (as a WebSocket does) and echoes
    let mut chat = app_device.listen(3001).await.unwrap();
    tokio::spawn(async move {
        while let Some(Accepted { mut stream, .. }) = chat.recv().await {
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
                assert!(head.contains("upgrade: echo") && head.contains("x-tailnet-user: alice.example.com"), "{head}");
                stream.write_all(b"HTTP/1.1 101 Switching Protocols\r\nConnection: upgrade\r\nUpgrade: echo\r\n\r\n").await.unwrap();
                let mut buf = [0u8; 256];
                while let Ok(n) = stream.read(&mut buf).await {
                    if n == 0 || stream.write_all(&buf[..n]).await.is_err() {
                        break;
                    }
                }
            });
        }
    });

    let provider = Arc::new(ring::default_provider());
    let client = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .unwrap()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Pinned(cert_der, provider)))
        .with_no_client_auth();
    World { viewer, outsider, connector: TlsConnector::from(Arc::new(client)), seen }
}

/// One HTTPS request from `from` to the gateway, with this server name.
async fn request(w: &World, from: &NetStack, name: &str, req: Request<Full<Bytes>>) -> Result<(StatusCode, http::HeaderMap, Vec<u8>), String> {
    let tcp = from.connect(SocketAddrV4::new(GATEWAY, 443)).await.map_err(|e| e.to_string())?;
    let tls = w.connector.connect(ServerName::try_from(name.to_string()).unwrap(), tcp).await.map_err(|e| e.to_string())?;
    let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(tls)).await.map_err(|e| e.to_string())?;
    tokio::spawn(conn);
    let res = sender.send_request(req).await.map_err(|e| e.to_string())?;
    let (parts, body) = res.into_parts();
    Ok((parts.status, parts.headers, body.collect().await.map_err(|e| e.to_string())?.to_bytes().to_vec()))
}

fn get(host: &str, path: &str) -> http::request::Builder {
    Request::builder().uri(path).header("host", host)
}

#[tokio::test]
async fn a_member_opens_a_named_service_over_https() {
    let w = world().await;
    let name = "food-app.ts.example.com";
    let (status, headers, body) = request(&w, &w.viewer, name, get(name, "/menu?day=1").body(Full::default()).unwrap()).await.unwrap();
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["x-app"], "food");
    assert_eq!(body, b"hello from food-app, 0 bytes");

    let seen = w.seen.lock().unwrap().clone();
    let (method, uri, got, _) = &seen[0];
    assert_eq!((method.as_str(), uri.as_str()), ("GET", "/menu?day=1"));
    let header = |k: &str| got.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
    assert_eq!(header("x-tailnet-user"), Some("alice.example.com"));
    assert_eq!(header("x-tailnet-device"), Some("alice-phone"));
    assert_eq!(header("x-forwarded-for"), Some("100.64.0.3"));
    assert_eq!(header("x-forwarded-proto"), Some("https"));
    assert_eq!(header("host"), Some(name), "the application sees the name the member used");
}

#[tokio::test]
async fn a_caller_cannot_forge_identity_headers_and_a_body_arrives_whole() {
    let w = world().await;
    let name = "food-app.ts.example.com";
    let body = vec![b'x'; 200_000];
    let req = Request::builder()
        .method("POST")
        .uri("/order")
        .header("host", name)
        .header("x-tailnet-user", "admin.example.com")
        .header("X-Tailnet-Role", "owner")
        .body(Full::new(Bytes::from(body)))
        .unwrap();
    let (status, _, answer) = request(&w, &w.viewer, name, req).await.unwrap();
    assert_eq!(status, StatusCode::OK);
    assert_eq!(answer, b"hello from food-app, 200000 bytes");
    let seen = w.seen.lock().unwrap().clone();
    let (_, _, got, received) = &seen[0];
    assert_eq!(received.len(), 200_000);
    let users: Vec<_> = got.iter().filter(|(n, _)| n == "x-tailnet-user").map(|(_, v)| v.as_str()).collect();
    assert_eq!(users, vec!["alice.example.com"], "only the gateway's value arrives");
    assert!(!got.iter().any(|(n, _)| n == "x-tailnet-role"), "other x-tailnet-* headers of the caller are removed");
}

#[tokio::test]
async fn an_unknown_name_and_a_device_that_may_not_see_the_service_get_the_same_answer() {
    let w = world().await;
    let unknown = "no-such.ts.example.com";
    let (s1, _, b1) = request(&w, &w.viewer, unknown, get(unknown, "/").body(Full::default()).unwrap()).await.unwrap();
    let real = "food-app.ts.example.com";
    let (s2, _, b2) = request(&w, &w.outsider, real, get(real, "/").body(Full::default()).unwrap()).await.unwrap();
    assert_eq!((s1, &b1), (StatusCode::NOT_FOUND, &b"Not found\n".to_vec()));
    assert_eq!((s2, b2), (s1, b1), "a hidden service looks like a name that does not exist");
    assert!(w.seen.lock().unwrap().is_empty(), "the application saw nothing");
}

#[tokio::test]
async fn a_request_for_another_name_on_the_connection_is_refused() {
    let w = world().await;
    // TLS for a name with no service, then ask for the real service in the Host header
    let (status, _, _) = request(&w, &w.viewer, "no-such.ts.example.com", get("food-app.ts.example.com", "/").body(Full::default()).unwrap()).await.unwrap();
    assert_eq!(status, StatusCode::MISDIRECTED_REQUEST);
    assert!(w.seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn plain_http_sends_the_browser_to_https() {
    let w = world().await;
    let mut tcp = w.viewer.connect(SocketAddrV4::new(GATEWAY, 80)).await.unwrap();
    tcp.write_all(b"GET /menu HTTP/1.1\r\nHost: food-app.ts.example.com\r\n\r\n").await.unwrap();
    let mut answer = vec![0u8; 512];
    let n = tokio::time::timeout(Duration::from_secs(5), tcp.read(&mut answer)).await.unwrap().unwrap();
    let answer = String::from_utf8_lossy(&answer[..n]).to_ascii_lowercase();
    assert!(answer.starts_with("http/1.1 308"), "{answer}");
    assert!(answer.contains("location: https://food-app.ts.example.com/menu"), "{answer}");
}

#[tokio::test]
async fn an_upgraded_connection_carries_bytes_both_ways() {
    let w = world().await;
    let name = "chat.ts.example.com";
    let tcp = w.viewer.connect(SocketAddrV4::new(GATEWAY, 443)).await.unwrap();
    let mut tls = w.connector.connect(ServerName::try_from(name).unwrap(), tcp).await.unwrap();
    tls.write_all(format!("GET /socket HTTP/1.1\r\nHost: {name}\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n").as_bytes()).await.unwrap();
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        tokio::time::timeout(Duration::from_secs(5), tls.read_exact(&mut byte)).await.unwrap().unwrap();
        head.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&head).to_ascii_lowercase();
    assert!(head.starts_with("http/1.1 101"), "{head}");
    assert!(head.contains("upgrade: echo"), "{head}");
    for message in [&b"ping"[..], &b"a second message"[..]] {
        tls.write_all(message).await.unwrap();
        let mut back = vec![0u8; message.len()];
        tokio::time::timeout(Duration::from_secs(5), tls.read_exact(&mut back)).await.unwrap().unwrap();
        assert_eq!(back, message);
    }
}
