//! HTTPS for named services (ADR-0030).
//!
//! The gateway listens on its tailnet address. It ends TLS with the wildcard
//! certificate of the base domain, finds the service from the TLS server
//! name, and passes the request to the device and port of that service over
//! the tailnet. It tells the application who is calling, in headers that a
//! caller cannot set.

use std::net::{Ipv4Addr, SocketAddrV4};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use bytes::Bytes;
use http::header::{HeaderName, HeaderValue, CONNECTION, HOST, UPGRADE};
use http::{Request, Response, StatusCode};
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::client::conn::http1::SendRequest;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::Mutex;
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer};
use tokio_rustls::rustls::ServerConfig;
use tokio_rustls::TlsAcceptor;
use tracing::{debug, warn};

use crate::netstack::{Accepted, NetStack};

pub const HTTPS_PORT: u16 = 443;
pub const HTTP_PORT: u16 = 80;
const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const HEADER_TIMEOUT: Duration = Duration::from_secs(15);
/// Headers that carry the caller's identity to the application.
pub const USER_HEADER: &str = "x-tailnet-user";
pub const DEVICE_HEADER: &str = "x-tailnet-device";
const IDENTITY_PREFIX: &str = "x-tailnet-";

/// Where a service lives and who is calling it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Route {
    /// Tailnet address and port of the application.
    pub target: SocketAddrV4,
    /// The caller's sign-in name (for example an AT Protocol handle).
    pub user: String,
    /// The name of the caller's device.
    pub device: String,
}

/// The services of one tailnet. The coordinator answers from its store.
#[async_trait::async_trait]
pub trait Services: Send + Sync + 'static {
    /// The service with this full name, as the device at `caller` may use
    /// it. `None` when there is no such service or this device may not see
    /// it: the two cases must look the same to the caller.
    async fn route(&self, server_name: &str, caller: Ipv4Addr) -> Option<Route>;
}

// ── Certificate ─────────────────────────────────────────────────────────

/// The TLS certificate of the gateway. It can be loaded again while
/// connections are open (the certificate is renewed every few weeks).
pub struct Certificate {
    config: RwLock<Arc<ServerConfig>>,
    files: Option<(PathBuf, PathBuf)>,
}

#[derive(Debug, thiserror::Error)]
pub enum CertificateError {
    #[error("cannot read {0}: {1}")]
    Read(PathBuf, std::io::Error),
    #[error("{0} has no certificate")]
    NoCertificate(PathBuf),
    #[error("{0} has no private key")]
    NoKey(PathBuf),
    #[error("the certificate and the key do not fit: {0}")]
    Tls(#[from] tokio_rustls::rustls::Error),
}

fn server_config(chain: Vec<CertificateDer<'static>>, key: PrivateKeyDer<'static>) -> Result<Arc<ServerConfig>, CertificateError> {
    // The provider is named here: other crates in the process bring their own
    let provider = Arc::new(tokio_rustls::rustls::crypto::ring::default_provider());
    let mut config = ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_single_cert(chain, key)?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(config))
}

fn read_files(cert: &PathBuf, key: &PathBuf) -> Result<Arc<ServerConfig>, CertificateError> {
    let cert_pem = std::fs::read(cert).map_err(|e| CertificateError::Read(cert.clone(), e))?;
    let key_pem = std::fs::read(key).map_err(|e| CertificateError::Read(key.clone(), e))?;
    let chain: Vec<_> = rustls_pemfile::certs(&mut cert_pem.as_slice()).filter_map(Result::ok).collect();
    if chain.is_empty() {
        return Err(CertificateError::NoCertificate(cert.clone()));
    }
    let key_der = rustls_pemfile::private_key(&mut key_pem.as_slice())
        .ok()
        .flatten()
        .ok_or_else(|| CertificateError::NoKey(key.clone()))?;
    server_config(chain, key_der)
}

impl Certificate {
    /// Load a PEM certificate chain and its PEM private key.
    pub fn from_files(cert: impl Into<PathBuf>, key: impl Into<PathBuf>) -> Result<Self, CertificateError> {
        let (cert, key) = (cert.into(), key.into());
        Ok(Self { config: RwLock::new(read_files(&cert, &key)?), files: Some((cert, key)) })
    }

    pub fn from_der(chain: Vec<CertificateDer<'static>>, key: PrivateKeyDer<'static>) -> Result<Self, CertificateError> {
        Ok(Self { config: RwLock::new(server_config(chain, key)?), files: None })
    }

    /// Read the files again. On an error the old certificate stays in use.
    pub fn reload(&self) -> Result<(), CertificateError> {
        if let Some((cert, key)) = &self.files {
            let fresh = read_files(cert, key)?;
            *self.config.write().unwrap_or_else(|e| e.into_inner()) = fresh;
        }
        Ok(())
    }

    fn acceptor(&self) -> TlsAcceptor {
        TlsAcceptor::from(self.config.read().unwrap_or_else(|e| e.into_inner()).clone())
    }
}

// ── Serving ─────────────────────────────────────────────────────────────

type Body = BoxBody<Bytes, hyper::Error>;

fn text(status: StatusCode, message: &'static str) -> Response<Body> {
    let mut response = Response::new(Full::new(Bytes::from_static(message.as_bytes())).map_err(|never| match never {}).boxed());
    *response.status_mut() = status;
    response.headers_mut().insert(http::header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    response
}

/// The answer for a name that is not a service, or not one for this caller.
fn not_found() -> Response<Body> {
    text(StatusCode::NOT_FOUND, "Not found\n")
}

/// Serve the named services of one tailnet until the stack stops.
pub async fn serve(stack: NetStack, certificate: Arc<Certificate>, services: Arc<dyn Services>) -> std::io::Result<()> {
    let mut https = stack.listen(HTTPS_PORT).await?;
    let mut http = stack.listen(HTTP_PORT).await?;
    loop {
        tokio::select! {
            accepted = https.recv() => {
                let Some(accepted) = accepted else { return Ok(()) };
                let (stack, certificate, services) = (stack.clone(), certificate.clone(), services.clone());
                tokio::spawn(async move {
                    if let Err(e) = https_connection(accepted, stack, certificate, services).await {
                        debug!(error = %e, "service connection ended with an error");
                    }
                });
            }
            accepted = http.recv() => {
                let Some(accepted) = accepted else { return Ok(()) };
                tokio::spawn(redirect_connection(accepted));
            }
        }
    }
}

/// Plain HTTP only sends the browser to HTTPS.
async fn redirect_connection(accepted: Accepted) {
    let service = service_fn(|req: Request<Incoming>| async move {
        let host = req.headers().get(HOST).and_then(|h| h.to_str().ok()).unwrap_or("");
        let host = host.split(':').next().unwrap_or("");
        let valid = !host.is_empty() && host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.');
        let mut response = text(StatusCode::PERMANENT_REDIRECT, "Use HTTPS\n");
        match HeaderValue::from_str(&format!("https://{host}{}", req.uri().path_and_query().map(|p| p.as_str()).unwrap_or("/"))) {
            Ok(location) if valid => {
                response.headers_mut().insert(http::header::LOCATION, location);
            }
            _ => *response.status_mut() = StatusCode::BAD_REQUEST,
        }
        Ok::<_, hyper::Error>(response)
    });
    let _ = hyper::server::conn::http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(HEADER_TIMEOUT)
        .keep_alive(false)
        .serve_connection(TokioIo::new(accepted.stream), service)
        .await;
}

/// One upstream connection, reused for the requests of one caller connection.
type Upstream = Arc<Mutex<Option<(SocketAddrV4, SendRequest<Incoming>)>>>;

async fn https_connection(
    accepted: Accepted,
    stack: NetStack,
    certificate: Arc<Certificate>,
    services: Arc<dyn Services>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let caller = *accepted.peer.ip();
    let tls = tokio::time::timeout(TLS_HANDSHAKE_TIMEOUT, certificate.acceptor().accept(accepted.stream)).await??;
    // The service is chosen by the name in the TLS handshake. A request for
    // another name on the same connection is refused below.
    let Some(server_name) = tls.get_ref().1.server_name().map(|s| s.to_ascii_lowercase()) else {
        return Ok(()); // no name: nothing to serve
    };
    let upstream: Upstream = Arc::new(Mutex::new(None));
    let service = service_fn(move |req| {
        let (stack, services, server_name, upstream) = (stack.clone(), services.clone(), server_name.clone(), upstream.clone());
        async move { Ok::<_, hyper::Error>(handle(req, caller, &server_name, stack, services, upstream).await) }
    });
    hyper::server::conn::http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(HEADER_TIMEOUT)
        .serve_connection(TokioIo::new(tls), service)
        .with_upgrades()
        .await?;
    Ok(())
}

fn host_of(req: &Request<Incoming>) -> Option<String> {
    let host = req.headers().get(HOST)?.to_str().ok()?;
    Some(host.rsplit_once(':').map_or(host, |(h, port)| if port.bytes().all(|b| b.is_ascii_digit()) { h } else { host }).to_ascii_lowercase())
}

/// Headers that belong to one hop and are not passed on.
const HOP_HEADERS: [&str; 7] = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding"];

async fn handle(
    mut req: Request<Incoming>,
    caller: Ipv4Addr,
    server_name: &str,
    stack: NetStack,
    services: Arc<dyn Services>,
    upstream: Upstream,
) -> Response<Body> {
    if host_of(&req).as_deref() != Some(server_name) {
        return text(StatusCode::MISDIRECTED_REQUEST, "This connection is for another name\n");
    }
    let Some(route) = services.route(server_name, caller).await else {
        return not_found();
    };

    // Identity headers come from the gateway only: remove what the caller sent
    let forged: Vec<HeaderName> = req.headers().keys().filter(|k| k.as_str().starts_with(IDENTITY_PREFIX)).cloned().collect();
    for name in forged {
        req.headers_mut().remove(name);
    }
    let upgrade = req.headers().get(UPGRADE).cloned();
    for name in HOP_HEADERS {
        req.headers_mut().remove(name);
    }
    match &upgrade {
        Some(protocol) => {
            req.headers_mut().insert(CONNECTION, HeaderValue::from_static("upgrade"));
            req.headers_mut().insert(UPGRADE, protocol.clone());
        }
        None => {
            req.headers_mut().remove(UPGRADE);
        }
    }
    let set = |req: &mut Request<Incoming>, name: &'static str, value: &str| {
        // A value that is not a legal header value is left out, never passed on raw
        if let Ok(v) = HeaderValue::from_str(value) {
            req.headers_mut().insert(HeaderName::from_static(name), v);
        }
    };
    set(&mut req, USER_HEADER, &route.user);
    set(&mut req, DEVICE_HEADER, &route.device);
    set(&mut req, "x-forwarded-for", &caller.to_string());
    set(&mut req, "x-forwarded-proto", "https");
    set(&mut req, "x-forwarded-host", server_name);

    let client_upgrade = upgrade.is_some().then(|| hyper::upgrade::on(&mut req));

    // An upgraded connection (for example a WebSocket) gets its own upstream
    let mut sender = if upgrade.is_some() {
        match connect(&stack, route.target).await {
            Ok(s) => s,
            Err(response) => return response,
        }
    } else {
        let mut slot = upstream.lock().await;
        match slot.take() {
            Some((target, s)) if target == route.target && !s.is_closed() => s,
            _ => match connect(&stack, route.target).await {
                Ok(s) => s,
                Err(response) => return response,
            },
        }
    };
    if sender.ready().await.is_err() {
        sender = match connect(&stack, route.target).await {
            Ok(s) => s,
            Err(response) => return response,
        };
    }

    let mut response = match sender.send_request(req).await {
        Ok(r) => r,
        Err(e) => {
            debug!(error = %e, target = %route.target, "the application did not answer");
            return text(StatusCode::BAD_GATEWAY, "The application did not answer\n");
        }
    };

    if response.status() == StatusCode::SWITCHING_PROTOCOLS {
        if let Some(client_upgrade) = client_upgrade {
            let app_upgrade = hyper::upgrade::on(&mut response);
            tokio::spawn(async move {
                if let (Ok(client), Ok(app)) = (client_upgrade.await, app_upgrade.await) {
                    let _ = tokio::io::copy_bidirectional(&mut TokioIo::new(client), &mut TokioIo::new(app)).await;
                }
            });
        }
    } else if upgrade.is_none() {
        *upstream.lock().await = Some((route.target, sender));
    }
    response.map(|body| body.boxed())
}

/// Open a connection to the application over the tailnet.
async fn connect(stack: &NetStack, target: SocketAddrV4) -> Result<SendRequest<Incoming>, Response<Body>> {
    let stream = stack.connect(target).await.map_err(|e| {
        debug!(error = %e, %target, "cannot reach the application");
        text(StatusCode::BAD_GATEWAY, "The device or the application is not reachable\n")
    })?;
    upstream_handshake(stream).await
}

async fn upstream_handshake<S>(stream: S) -> Result<SendRequest<Incoming>, Response<Body>>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .map_err(|_| text(StatusCode::BAD_GATEWAY, "The application did not answer\n"))?;
    tokio::spawn(async move {
        if let Err(e) = connection.with_upgrades().await {
            debug!(error = %e, "connection to the application ended");
        }
    });
    Ok(sender)
}

/// Load the certificate again from time to time, so a renewed certificate
/// is used without a restart.
pub fn spawn_reload(certificate: Arc<Certificate>, every: Duration) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(every);
        tick.tick().await;
        loop {
            tick.tick().await;
            if let Err(e) = certificate.reload() {
                warn!(error = %e, "could not reload the gateway certificate; the old one stays in use");
            }
        }
    });
}
