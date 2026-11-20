//! The DERP relay server: handshake, admission, and packet forwarding.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use bytes::Bytes;
use crypto_box::aead::Aead;
use crypto_box::{PublicKey, SalsaBox, SecretKey};
use rand::RngCore;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader, BufWriter};
use tokio::sync::{Notify, Semaphore};
use tokio::time::Instant;
use tracing::{debug, info};

use crate::frame::*;

/// Time a client has to complete the handshake.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Peers remembered per client for "peer gone" notifications.
const MAX_TRACKED_SENDERS: usize = 4096;
/// `TS💬` — prefix of a disco packet (path discovery) as relayed over DERP.
const DISCO_MAGIC: &[u8; 6] = b"TS\xf0\x9f\x92\xac";
/// "Not here" notices a client may trigger: a burst, then one per interval.
const NOT_HERE_BURST: u32 = 3;
const NOT_HERE_INTERVAL: Duration = Duration::from_secs(1);

/// Who may talk to whom through the relay. Nodes are grouped by tenant; a
/// node reaches nodes of its own tenant and of its tenant's parent or
/// children (the same visibility the coordinator's netmap gives them).
///
/// `parent` is the link to the parent tenant, and both directions of
/// parent/child relaying depend on it: admission sets it only while the
/// child is visible to its parent (posture not Closed, neither suspended).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scope {
    pub tenant: [u8; 16],
    pub parent: Option<[u8; 16]>,
}

impl Scope {
    pub fn can_reach(&self, other: &Scope) -> bool {
        self.tenant == other.tenant || self.parent == Some(other.tenant) || other.parent == Some(self.tenant)
    }
}

/// Decides which node keys may use the relay.
#[async_trait::async_trait]
pub trait Admission: Send + Sync + 'static {
    /// The scope of an admitted node, or `None` to refuse it. Called at
    /// connect time and again periodically while the node stays connected.
    async fn admit(&self, node_key: &[u8; 32]) -> Option<Scope>;
}

/// Admits every key into one shared scope. For tests and single-tenant setups.
pub struct AllowAll;

#[async_trait::async_trait]
impl Admission for AllowAll {
    async fn admit(&self, _node_key: &[u8; 32]) -> Option<Scope> {
        Some(Scope { tenant: [0; 16], parent: None })
    }
}

#[derive(Debug, Clone)]
pub struct DerpConfig {
    /// Connections served at once; further clients are refused.
    pub max_clients: usize,
    /// Packets queued per client before the oldest is dropped.
    pub send_queue_depth: usize,
    /// Sustained bytes per second a client may send (`None` = unlimited).
    pub bytes_per_second: Option<u64>,
    /// Bytes a client may send in a burst before the rate applies.
    pub burst_bytes: u64,
    /// Interval between keep-alive frames (and admission re-checks).
    pub keep_alive: Duration,
}

impl Default for DerpConfig {
    fn default() -> Self {
        Self {
            max_clients: 4096,
            send_queue_depth: 32,
            bytes_per_second: Some(4 << 20),
            burst_bytes: 8 << 20,
            keep_alive: KEEP_ALIVE,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum DerpError {
    #[error("relay is at its connection limit")]
    TooManyClients,
    #[error("handshake timed out")]
    HandshakeTimeout,
    #[error("protocol error: {0}")]
    Protocol(&'static str),
    #[error("node is not admitted to this relay")]
    NotAdmitted,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// Packets queued for an in-process client (it serves many peers at once).
const LOCAL_QUEUE_DEPTH: usize = 2048;

/// A relay client inside this process. Detaches when dropped.
pub struct LocalClient {
    server: Arc<DerpServer>,
    client: Arc<Client>,
    not_here: Mutex<NoticeLimiter>,
}

impl LocalClient {
    pub fn key(&self) -> [u8; 32] {
        self.client.key
    }

    /// The next packet sent to this client: (sender key, payload). `None`
    /// after the client was replaced by another with the same key.
    pub async fn recv(&self) -> Option<([u8; 32], Bytes)> {
        loop {
            // Register for a wake-up before looking, so a packet that arrives
            // between the look and the wait is not missed.
            let notified = self.client.queue.notify.notified();
            while let Some(item) = self.client.queue.pop() {
                if let Outbound::Packet { src, data } = item {
                    return Some((src, data));
                }
            }
            if self.client.queue.closed.load(Ordering::Acquire) {
                return None;
            }
            notified.await;
        }
    }

    /// Send a packet to a peer in this client's scope. Dropped without a
    /// trace when the peer is not connected (WireGuard retransmits).
    pub fn send(&self, dst: [u8; 32], data: Bytes) {
        let mut not_here = self.not_here.lock().unwrap_or_else(|e| e.into_inner());
        self.server.forward(&self.client, dst, data, &mut not_here);
    }
}

impl Drop for LocalClient {
    fn drop(&mut self) {
        self.client.queue.close();
        self.server.unregister(&self.client);
    }
}

enum Outbound {
    Packet { src: [u8; 32], data: Bytes },
    PeerGone { key: [u8; 32], reason: u8 },
    Pong([u8; 8]),
    KeepAlive,
}

/// Bounded outbound queue. When full, the oldest packet is dropped so fresh
/// packets win (WireGuard retransmits; stale packets are worthless).
struct SendQueue {
    items: Mutex<VecDeque<Outbound>>,
    notify: Notify,
    closed: AtomicBool,
    depth: usize,
}

impl SendQueue {
    fn push(&self, item: Outbound) {
        {
            let mut q = self.items.lock().unwrap_or_else(|e| e.into_inner());
            if q.len() >= self.depth {
                q.pop_front();
            }
            q.push_back(item);
        }
        self.notify.notify_one();
    }

    fn pop(&self) -> Option<Outbound> {
        self.items.lock().unwrap_or_else(|e| e.into_inner()).pop_front()
    }

    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.notify.notify_one();
    }
}

struct Client {
    /// Distinguishes this connection from a later one with the same key.
    id: u64,
    key: [u8; 32],
    /// Re-read at every admission re-check: a parent/child link can close
    /// (posture, suspension) while the client stays connected.
    scope: RwLock<Scope>,
    queue: SendQueue,
    /// Peers that sent packets here; told when this client disconnects.
    senders: Mutex<HashSet<[u8; 32]>>,
}

impl Client {
    fn scope(&self) -> Scope {
        self.scope.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn set_scope(&self, scope: Scope) {
        *self.scope.write().unwrap_or_else(|e| e.into_inner()) = scope;
    }
}

pub struct DerpServer {
    secret: SecretKey,
    public: [u8; 32],
    admission: Arc<dyn Admission>,
    config: DerpConfig,
    clients: RwLock<HashMap<[u8; 32], Arc<Client>>>,
    next_id: AtomicU64,
    conns: Arc<Semaphore>,
}

impl DerpServer {
    pub fn new(secret: [u8; 32], admission: Arc<dyn Admission>, config: DerpConfig) -> Self {
        let secret = SecretKey::from(secret);
        let public = *secret.public_key().as_bytes();
        Self {
            secret,
            public,
            admission,
            conns: Arc::new(Semaphore::new(config.max_clients)),
            config,
            clients: RwLock::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }
    }

    /// The relay's public key (sent to clients in the first frame).
    pub fn public_key(&self) -> [u8; 32] {
        self.public
    }

    pub fn connected_clients(&self) -> usize {
        self.clients.read().unwrap_or_else(|e| e.into_inner()).len()
    }

    /// Attach a client that lives in this process (the gateway, ADR-0029). It
    /// is a relay client like any other: peers in its scope send to its key
    /// and receive from it. It needs no connection and no handshake, because
    /// the caller is trusted code that states its own key and scope.
    pub fn attach_local(self: &Arc<Self>, key: [u8; 32], scope: Scope) -> LocalClient {
        let client = Arc::new(Client {
            id: self.next_id.fetch_add(1, Ordering::Relaxed),
            key,
            scope: RwLock::new(scope),
            queue: SendQueue {
                items: Mutex::new(VecDeque::new()),
                notify: Notify::new(),
                closed: AtomicBool::new(false),
                depth: LOCAL_QUEUE_DEPTH,
            },
            senders: Mutex::new(HashSet::new()),
        });
        self.clients
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key, client.clone());
        debug!(node = %hex::encode(&key[..8]), "local derp client attached");
        LocalClient { server: self.clone(), client, not_here: Mutex::new(NoticeLimiter::new()) }
    }

    /// Serve one client over `io` (the stream after the HTTP upgrade) until
    /// it disconnects or misbehaves.
    pub async fn serve_conn<S>(&self, io: S) -> Result<(), DerpError>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send,
    {
        let _permit = self.conns.clone().try_acquire_owned().map_err(|_| DerpError::TooManyClients)?;
        let (r, w) = tokio::io::split(io);
        let mut r = BufReader::new(r);
        let mut w = BufWriter::new(w);

        write_frame(&mut w, FRAME_SERVER_KEY, &[MAGIC, &self.public]).await?;
        w.flush().await?;

        let key = tokio::time::timeout(HANDSHAKE_TIMEOUT, self.read_client_info(&mut r))
            .await
            .map_err(|_| DerpError::HandshakeTimeout)??;
        let scope = self.admission.admit(&key).await.ok_or(DerpError::NotAdmitted)?;

        let (nonce, sealed) = self.seal(&key, format!("{{\"version\":{PROTOCOL_VERSION}}}").as_bytes())?;
        write_frame(&mut w, FRAME_SERVER_INFO, &[&nonce, &sealed]).await?;
        w.flush().await?;

        let client = Arc::new(Client {
            id: self.next_id.fetch_add(1, Ordering::Relaxed),
            key,
            scope: RwLock::new(scope),
            queue: SendQueue {
                items: Mutex::new(VecDeque::new()),
                notify: Notify::new(),
                closed: AtomicBool::new(false),
                depth: self.config.send_queue_depth.max(1),
            },
            senders: Mutex::new(HashSet::new()),
        });
        // The newest connection for a key becomes the active one. An older
        // connection keeps running but no longer receives packets.
        self.clients
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key, client.clone());
        debug!(node = %hex::encode(&key[..8]), "derp client connected");

        let result = tokio::select! {
            r = self.read_loop(&client, &mut r) => r,
            w = self.write_loop(&client, &mut w) => w,
        };
        client.queue.close();
        self.unregister(&client);
        debug!(node = %hex::encode(&key[..8]), "derp client disconnected");
        match result {
            // A client closing its connection is the normal way a session ends.
            Err(DerpError::Io(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => Ok(()),
            other => other,
        }
    }

    async fn read_client_info<R: AsyncRead + Unpin>(&self, r: &mut R) -> Result<[u8; 32], DerpError> {
        let (ty, len) = read_header(r).await?;
        let len = len as usize;
        if ty != FRAME_CLIENT_INFO {
            return Err(DerpError::Protocol("expected client info"));
        }
        if !(KEY_LEN + NONCE_LEN..=MAX_CLIENT_INFO_LEN).contains(&len) {
            return Err(DerpError::Protocol("bad client info length"));
        }
        let mut key = [0u8; KEY_LEN];
        r.read_exact(&mut key).await?;
        let mut nonce = [0u8; NONCE_LEN];
        r.read_exact(&mut nonce).await?;
        let mut sealed = vec![0u8; len - KEY_LEN - NONCE_LEN];
        r.read_exact(&mut sealed).await?;

        // Opening the box proves the client holds the private key for `key`.
        let plain = SalsaBox::new(&PublicKey::from(key), &self.secret)
            .decrypt(crypto_box::Nonce::from_slice(&nonce), sealed.as_slice())
            .map_err(|_| DerpError::Protocol("client info did not decrypt"))?;
        let info: ClientInfo =
            serde_json::from_slice(&plain).map_err(|_| DerpError::Protocol("client info is not JSON"))?;
        if info.version != PROTOCOL_VERSION {
            return Err(DerpError::Protocol("unsupported protocol version"));
        }
        Ok(key)
    }

    fn seal(&self, to: &[u8; 32], plain: &[u8]) -> Result<([u8; NONCE_LEN], Vec<u8>), DerpError> {
        let mut nonce = [0u8; NONCE_LEN];
        rand::rng().fill_bytes(&mut nonce);
        let sealed = SalsaBox::new(&PublicKey::from(*to), &self.secret)
            .encrypt(crypto_box::Nonce::from_slice(&nonce), plain)
            .map_err(|_| DerpError::Protocol("seal failed"))?;
        Ok((nonce, sealed))
    }

    async fn read_loop<R: AsyncRead + Unpin>(&self, client: &Arc<Client>, r: &mut R) -> Result<(), DerpError> {
        let mut limiter = self
            .config
            .bytes_per_second
            .map(|rate| TokenBucket::new(rate, self.config.burst_bytes.max(MAX_PACKET_SIZE as u64)));
        let mut not_here = NoticeLimiter::new();
        loop {
            let (ty, len) = read_header(r).await?;
            match ty {
                FRAME_SEND_PACKET => {
                    let len = len as usize;
                    if len < KEY_LEN || len - KEY_LEN > MAX_PACKET_SIZE {
                        return Err(DerpError::Protocol("bad send-packet length"));
                    }
                    let mut dst = [0u8; KEY_LEN];
                    r.read_exact(&mut dst).await?;
                    let mut data = vec![0u8; len - KEY_LEN];
                    r.read_exact(&mut data).await?;
                    if let Some(l) = limiter.as_mut() {
                        // Back-pressure: a client over its rate is read more slowly.
                        l.acquire(len as u64).await;
                    }
                    self.forward(client, dst, Bytes::from(data), &mut not_here);
                }
                FRAME_PING => {
                    if !(8..=1000).contains(&len) {
                        return Err(DerpError::Protocol("bad ping length"));
                    }
                    let mut payload = [0u8; 8];
                    r.read_exact(&mut payload).await?;
                    discard(r, len - 8).await?;
                    client.queue.push(Outbound::Pong(payload));
                }
                // Home-relay hints, client keep-alives and frames this relay
                // does not implement (mesh) carry nothing we need.
                _ => {
                    if len as usize > MAX_PACKET_SIZE + 2 * KEY_LEN {
                        return Err(DerpError::Protocol("oversized frame"));
                    }
                    discard(r, len).await?;
                }
            }
        }
    }

    fn forward(&self, from: &Arc<Client>, dst: [u8; 32], data: Bytes, not_here: &mut NoticeLimiter) {
        let target = self
            .clients
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(&dst)
            .cloned()
            // A peer outside the sender's scope is treated exactly like an
            // unknown one, so the relay does not reveal who is connected.
            .filter(|t| from.scope().can_reach(&t.scope()));
        match target {
            Some(t) => {
                {
                    let mut senders = t.senders.lock().unwrap_or_else(|e| e.into_inner());
                    if senders.len() < MAX_TRACKED_SENDERS {
                        senders.insert(from.key);
                    }
                }
                t.queue.push(Outbound::Packet { src: from.key, data });
            }
            None => {
                // Only disco (path discovery) packets get a "not here" reply:
                // it lets the sender stop probing a peer that left.
                if looks_like_disco(&data) && not_here.allow() {
                    from.queue.push(Outbound::PeerGone { key: dst, reason: PEER_GONE_NOT_HERE });
                }
            }
        }
    }

    async fn write_loop<W: AsyncWrite + Unpin>(&self, client: &Arc<Client>, w: &mut W) -> Result<(), DerpError> {
        let mut next_keep_alive = Instant::now() + self.keep_alive_interval();
        loop {
            while let Some(item) = client.queue.pop() {
                match item {
                    Outbound::Packet { src, data } => write_frame(w, FRAME_RECV_PACKET, &[&src, &data]).await?,
                    Outbound::PeerGone { key, reason } => write_frame(w, FRAME_PEER_GONE, &[&key, &[reason]]).await?,
                    Outbound::Pong(p) => write_frame(w, FRAME_PONG, &[&p]).await?,
                    Outbound::KeepAlive => write_frame(w, FRAME_KEEP_ALIVE, &[]).await?,
                }
            }
            w.flush().await?;
            if client.queue.closed.load(Ordering::Acquire) {
                return Ok(());
            }
            tokio::select! {
                _ = client.queue.notify.notified() => {}
                _ = tokio::time::sleep_until(next_keep_alive) => {
                    // A node removed or suspended after it connected loses the relay here.
                    match self.admission.admit(&client.key).await {
                        None => {
                            info!(node = %hex::encode(&client.key[..8]), "derp client no longer admitted");
                            return Err(DerpError::NotAdmitted);
                        }
                        // The reach of the client follows its tenant (a child that
                        // turned Closed, a parent that was suspended).
                        Some(scope) => client.set_scope(scope),
                    }
                    client.queue.push(Outbound::KeepAlive);
                    next_keep_alive = Instant::now() + self.keep_alive_interval();
                }
            }
        }
    }

    fn keep_alive_interval(&self) -> Duration {
        // Jitter spreads keep-alives of clients that connected together
        // (up to 5 s, less for short intervals).
        let max_jitter = (self.config.keep_alive.as_millis() / 12).clamp(1, 5000) as u64;
        self.config.keep_alive + Duration::from_millis(rand::random_range(0..max_jitter))
    }

    fn unregister(&self, client: &Arc<Client>) {
        {
            let mut clients = self.clients.write().unwrap_or_else(|e| e.into_inner());
            match clients.get(&client.key) {
                Some(current) if current.id == client.id => {
                    clients.remove(&client.key);
                }
                // A newer connection took over this key: the node is still here.
                _ => return,
            }
        }
        let senders: Vec<[u8; 32]> = client
            .senders
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
            .collect();
        let clients = self.clients.read().unwrap_or_else(|e| e.into_inner());
        for s in senders {
            if let Some(peer) = clients.get(&s) {
                peer.queue.push(Outbound::PeerGone { key: client.key, reason: PEER_GONE_DISCONNECTED });
            }
        }
    }
}

#[derive(serde::Deserialize)]
struct ClientInfo {
    #[serde(default)]
    version: u32,
}

fn looks_like_disco(data: &[u8]) -> bool {
    data.len() >= DISCO_MAGIC.len() + KEY_LEN + NONCE_LEN && data.starts_with(DISCO_MAGIC)
}

/// Byte-rate limiter for one connection (used only by its read loop).
struct TokenBucket {
    rate: f64,
    burst: f64,
    tokens: f64,
    last: Instant,
}

impl TokenBucket {
    fn new(rate: u64, burst: u64) -> Self {
        Self { rate: rate.max(1) as f64, burst: burst as f64, tokens: burst as f64, last: Instant::now() }
    }

    async fn acquire(&mut self, n: u64) {
        let now = Instant::now();
        self.tokens = (self.tokens + now.duration_since(self.last).as_secs_f64() * self.rate).min(self.burst);
        self.last = now;
        self.tokens -= n as f64;
        if self.tokens < 0.0 {
            tokio::time::sleep(Duration::from_secs_f64(-self.tokens / self.rate)).await;
        }
    }
}

/// Limits "not here" notices so a client cannot use them to scan for keys cheaply.
struct NoticeLimiter {
    remaining: u32,
    last: Instant,
}

impl NoticeLimiter {
    fn new() -> Self {
        Self { remaining: NOT_HERE_BURST, last: Instant::now() }
    }

    fn allow(&mut self) -> bool {
        let now = Instant::now();
        let refill = (now.duration_since(self.last).as_millis() / NOT_HERE_INTERVAL.as_millis()) as u32;
        if refill > 0 {
            self.remaining = (self.remaining + refill).min(NOT_HERE_BURST);
            self.last = now;
        }
        if self.remaining == 0 {
            return false;
        }
        self.remaining -= 1;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::DuplexStream;

    /// A minimal DERP client, written from the protocol description.
    struct TestClient {
        io: DuplexStream,
        key: [u8; 32],
    }

    impl TestClient {
        async fn connect(server: &Arc<DerpServer>, seed: u8) -> Result<Self, String> {
            let (a, b) = tokio::io::duplex(1 << 20);
            let srv = server.clone();
            tokio::spawn(async move {
                let _ = srv.serve_conn(b).await;
            });
            let secret = SecretKey::from([seed; 32]);
            let key = *secret.public_key().as_bytes();
            let mut c = TestClient { io: a, key };

            let (ty, len) = read_header(&mut c.io).await.map_err(|e| e.to_string())?;
            assert_eq!((ty, len), (FRAME_SERVER_KEY, 40));
            let mut magic = [0u8; 8];
            c.io.read_exact(&mut magic).await.unwrap();
            assert_eq!(&magic, MAGIC);
            let mut server_key = [0u8; 32];
            c.io.read_exact(&mut server_key).await.unwrap();
            assert_eq!(server_key, server.public_key());

            let salsa = SalsaBox::new(&PublicKey::from(server_key), &secret);
            let nonce = [seed; 24];
            let sealed = salsa
                .encrypt(crypto_box::Nonce::from_slice(&nonce), &br#"{"version":2,"CanAckPings":true}"#[..])
                .unwrap();
            write_frame(&mut c.io, FRAME_CLIENT_INFO, &[&key, &nonce, &sealed]).await.unwrap();

            let (ty, len) = read_header(&mut c.io).await.map_err(|e| e.to_string())?;
            if ty != FRAME_SERVER_INFO {
                return Err(format!("unexpected frame {ty:#x}"));
            }
            let mut body = vec![0u8; len as usize];
            c.io.read_exact(&mut body).await.map_err(|e| e.to_string())?;
            let plain = salsa
                .decrypt(crypto_box::Nonce::from_slice(&body[..24]), &body[24..])
                .map_err(|_| "server info did not decrypt".to_string())?;
            assert_eq!(plain, br#"{"version":2}"#);
            Ok(c)
        }

        async fn send(&mut self, dst: [u8; 32], data: &[u8]) {
            write_frame(&mut self.io, FRAME_SEND_PACKET, &[&dst, data]).await.unwrap();
        }

        /// Next frame that is not a keep-alive.
        async fn recv(&mut self) -> (u8, Vec<u8>) {
            loop {
                let (ty, len) = tokio::time::timeout(Duration::from_secs(2), read_header(&mut self.io))
                    .await
                    .expect("timed out waiting for a frame")
                    .unwrap();
                let mut body = vec![0u8; len as usize];
                self.io.read_exact(&mut body).await.unwrap();
                if ty != FRAME_KEEP_ALIVE {
                    return (ty, body);
                }
            }
        }

        /// No frame other than keep-alives for a short while.
        async fn expect_silence(&mut self) {
            let deadline = tokio::time::Instant::now() + Duration::from_millis(150);
            loop {
                match tokio::time::timeout_at(deadline, read_header(&mut self.io)).await {
                    Err(_) => return,
                    Ok(Ok((FRAME_KEEP_ALIVE, len))) => {
                        let mut body = vec![0u8; len as usize];
                        self.io.read_exact(&mut body).await.unwrap();
                    }
                    Ok(other) => panic!("expected no frame, got {other:?}"),
                }
            }
        }
    }

    fn server(admission: Arc<dyn Admission>) -> Arc<DerpServer> {
        Arc::new(DerpServer::new([42; 32], admission, DerpConfig::default()))
    }

    fn disco_packet() -> Vec<u8> {
        let mut p = DISCO_MAGIC.to_vec();
        p.extend_from_slice(&[0u8; 32 + 24 + 16]);
        p
    }

    async fn wait_for_clients(s: &DerpServer, n: usize) {
        for _ in 0..200 {
            if s.connected_clients() == n {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("expected {n} clients, have {}", s.connected_clients());
    }

    #[tokio::test]
    async fn relays_packets_with_the_source_key() {
        let s = server(Arc::new(AllowAll));
        let mut a = TestClient::connect(&s, 1).await.unwrap();
        let mut b = TestClient::connect(&s, 2).await.unwrap();
        wait_for_clients(&s, 2).await;

        a.send(b.key, b"wireguard bytes").await;
        let (ty, body) = b.recv().await;
        assert_eq!(ty, FRAME_RECV_PACKET);
        assert_eq!(&body[..32], &a.key);
        assert_eq!(&body[32..], b"wireguard bytes");

        b.send(a.key, b"reply").await;
        let (_, body) = a.recv().await;
        assert_eq!(&body[..32], &b.key);
        assert_eq!(&body[32..], b"reply");
    }

    #[tokio::test]
    async fn answers_ping_with_pong() {
        let s = server(Arc::new(AllowAll));
        let mut a = TestClient::connect(&s, 1).await.unwrap();
        write_frame(&mut a.io, FRAME_PING, &[&[1, 2, 3, 4, 5, 6, 7, 8]]).await.unwrap();
        assert_eq!(a.recv().await, (FRAME_PONG, vec![1, 2, 3, 4, 5, 6, 7, 8]));
    }

    #[tokio::test]
    async fn unknown_destination_gets_not_here_only_for_disco_and_rate_limited() {
        let s = server(Arc::new(AllowAll));
        let mut a = TestClient::connect(&s, 1).await.unwrap();
        wait_for_clients(&s, 1).await;
        let ghost = [9u8; 32];

        a.send(ghost, b"plain wireguard").await;
        a.expect_silence().await;

        for _ in 0..NOT_HERE_BURST + 2 {
            a.send(ghost, &disco_packet()).await;
        }
        for _ in 0..NOT_HERE_BURST {
            let (ty, body) = a.recv().await;
            assert_eq!(ty, FRAME_PEER_GONE);
            assert_eq!(&body[..32], &ghost);
            assert_eq!(body[32], PEER_GONE_NOT_HERE);
        }
        a.expect_silence().await;
    }

    #[tokio::test]
    async fn sender_is_told_when_its_peer_disconnects() {
        let s = server(Arc::new(AllowAll));
        let mut a = TestClient::connect(&s, 1).await.unwrap();
        let mut b = TestClient::connect(&s, 2).await.unwrap();
        wait_for_clients(&s, 2).await;
        a.send(b.key, b"hi").await;
        b.recv().await;

        let b_key = b.key;
        drop(b);
        let (ty, body) = a.recv().await;
        assert_eq!(ty, FRAME_PEER_GONE);
        assert_eq!(&body[..32], &b_key);
        assert_eq!(body[32], PEER_GONE_DISCONNECTED);
        wait_for_clients(&s, 1).await;
    }

    struct ByFirstByte;

    /// Tenant is derived from the seed: 1x → tenant 1, 2x → tenant 2 (child of 1), 3x → tenant 3; 9x refused.
    #[async_trait::async_trait]
    impl Admission for ByFirstByte {
        async fn admit(&self, node_key: &[u8; 32]) -> Option<Scope> {
            let seed = (1u8..=99).find(|s| SecretKey::from([*s; 32]).public_key().as_bytes() == node_key)?;
            match seed / 10 {
                1 => Some(Scope { tenant: [1; 16], parent: None }),
                2 => Some(Scope { tenant: [2; 16], parent: Some([1; 16]) }),
                3 => Some(Scope { tenant: [3; 16], parent: None }),
                _ => None,
            }
        }
    }

    #[tokio::test]
    async fn refuses_nodes_that_are_not_admitted() {
        let s = server(Arc::new(ByFirstByte));
        assert!(TestClient::connect(&s, 90).await.is_err());
        assert_eq!(s.connected_clients(), 0);
    }

    #[tokio::test]
    async fn relays_within_a_tenant_and_parent_child_but_not_across_tenants() {
        let s = server(Arc::new(ByFirstByte));
        let mut parent = TestClient::connect(&s, 10).await.unwrap();
        let mut sibling = TestClient::connect(&s, 11).await.unwrap();
        let mut child = TestClient::connect(&s, 20).await.unwrap();
        let mut stranger = TestClient::connect(&s, 30).await.unwrap();
        wait_for_clients(&s, 4).await;

        parent.send(sibling.key, b"same tenant").await;
        assert_eq!(&sibling.recv().await.1[32..], b"same tenant");

        child.send(parent.key, b"to parent").await;
        assert_eq!(&parent.recv().await.1[32..], b"to parent");

        // Across unrelated tenants: dropped, and indistinguishable from "unknown key"
        stranger.send(parent.key, b"cross tenant").await;
        parent.expect_silence().await;
        stranger.send(parent.key, &disco_packet()).await;
        let (ty, body) = stranger.recv().await;
        assert_eq!((ty, body[32]), (FRAME_PEER_GONE, PEER_GONE_NOT_HERE));
    }

    /// Tenant 1 is the parent of tenant 2; `linked` says whether the child is
    /// visible to the parent (posture not Closed, neither suspended), as
    /// `StoreAdmission` decides it from the store.
    struct LinkedChild {
        linked: AtomicBool,
    }

    #[async_trait::async_trait]
    impl Admission for LinkedChild {
        async fn admit(&self, node_key: &[u8; 32]) -> Option<Scope> {
            let seed = (1u8..=99).find(|s| SecretKey::from([*s; 32]).public_key().as_bytes() == node_key)?;
            match seed / 10 {
                1 => Some(Scope { tenant: [1; 16], parent: None }),
                2 => Some(Scope {
                    tenant: [2; 16],
                    parent: self.linked.load(Ordering::SeqCst).then_some([1; 16]),
                }),
                _ => None,
            }
        }
    }

    #[tokio::test]
    async fn a_closed_or_suspended_child_gets_no_relay_to_or_from_its_parent() {
        let s = server(Arc::new(LinkedChild { linked: AtomicBool::new(false) }));
        let mut parent = TestClient::connect(&s, 10).await.unwrap();
        let mut child = TestClient::connect(&s, 20).await.unwrap();
        let mut child_sibling = TestClient::connect(&s, 21).await.unwrap();
        wait_for_clients(&s, 3).await;

        child.send(parent.key, b"up").await;
        parent.expect_silence().await;
        parent.send(child.key, b"down").await;
        child.expect_silence().await;
        // Inside the child tenant relaying still works
        child.send(child_sibling.key, b"same tenant").await;
        assert_eq!(&child_sibling.recv().await.1[32..], b"same tenant");
    }

    #[tokio::test]
    async fn closing_the_parent_link_takes_effect_at_the_next_admission_check() {
        let admission = Arc::new(LinkedChild { linked: AtomicBool::new(true) });
        let config = DerpConfig { keep_alive: Duration::from_millis(40), ..DerpConfig::default() };
        let s = Arc::new(DerpServer::new([42; 32], admission.clone(), config));
        let mut parent = TestClient::connect(&s, 10).await.unwrap();
        let mut child = TestClient::connect(&s, 20).await.unwrap();
        wait_for_clients(&s, 2).await;

        child.send(parent.key, b"while linked").await;
        assert_eq!(&parent.recv().await.1[32..], b"while linked");

        // The child turns Closed (or the parent is suspended) while both stay connected
        admission.linked.store(false, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(200)).await;
        child.send(parent.key, b"after close").await;
        parent.expect_silence().await;
        parent.send(child.key, b"after close").await;
        child.expect_silence().await;
        assert_eq!(s.connected_clients(), 2, "both stay connected inside their own tenant");
    }

    #[tokio::test]
    async fn newest_connection_for_a_key_receives_packets() {
        let s = server(Arc::new(AllowAll));
        let mut a = TestClient::connect(&s, 1).await.unwrap();
        let mut b_old = TestClient::connect(&s, 2).await.unwrap();
        wait_for_clients(&s, 2).await;
        let mut b_new = TestClient::connect(&s, 2).await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(s.connected_clients(), 2);

        a.send(b_new.key, b"for the new one").await;
        assert_eq!(&b_new.recv().await.1[32..], b"for the new one");
        b_old.expect_silence().await;

        // The old connection ending must not unregister the new one
        drop(b_old);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(s.connected_clients(), 2);
    }

    #[tokio::test]
    async fn rejects_bad_handshakes_and_oversized_packets() {
        let s = server(Arc::new(AllowAll));

        // Wrong first frame
        let (mut a, b) = tokio::io::duplex(1 << 16);
        let srv = s.clone();
        let h = tokio::spawn(async move { srv.serve_conn(b).await });
        let mut skip = [0u8; 45];
        a.read_exact(&mut skip).await.unwrap();
        write_frame(&mut a, FRAME_SEND_PACKET, &[&[0u8; 60]]).await.unwrap();
        assert!(matches!(h.await.unwrap(), Err(DerpError::Protocol(_))));

        // Client info that does not decrypt (claims a key it does not hold)
        let (mut a, b) = tokio::io::duplex(1 << 16);
        let srv = s.clone();
        let h = tokio::spawn(async move { srv.serve_conn(b).await });
        a.read_exact(&mut skip).await.unwrap();
        write_frame(&mut a, FRAME_CLIENT_INFO, &[&[7u8; 32], &[0u8; 24], &[1u8; 40]]).await.unwrap();
        assert!(matches!(h.await.unwrap(), Err(DerpError::Protocol(_))));

        // Oversized packet after a good handshake closes the connection
        let mut c = TestClient::connect(&s, 1).await.unwrap();
        let hdr = [FRAME_SEND_PACKET, 0x00, 0x02, 0x00, 0x00];
        c.io.write_all(&hdr).await.unwrap();
        let mut buf = [0u8; 1];
        let closed = tokio::time::timeout(Duration::from_secs(2), c.io.read(&mut buf)).await.unwrap();
        assert!(matches!(closed, Ok(0) | Err(_)));
    }

    #[tokio::test]
    async fn full_queue_drops_the_oldest_packet() {
        let q = SendQueue { items: Mutex::new(VecDeque::new()), notify: Notify::new(), closed: AtomicBool::new(false), depth: 2 };
        for i in 0..3u8 {
            q.push(Outbound::Pong([i; 8]));
        }
        assert!(matches!(q.pop(), Some(Outbound::Pong(p)) if p == [1; 8]));
        assert!(matches!(q.pop(), Some(Outbound::Pong(p)) if p == [2; 8]));
        assert!(q.pop().is_none());
    }

    #[tokio::test]
    async fn connection_limit_is_enforced() {
        let s = Arc::new(DerpServer::new([42; 32], Arc::new(AllowAll), DerpConfig { max_clients: 1, ..Default::default() }));
        let _a = TestClient::connect(&s, 1).await.unwrap();
        let (_x, b) = tokio::io::duplex(1024);
        assert!(matches!(s.serve_conn(b).await, Err(DerpError::TooManyClients)));
    }

    #[tokio::test(start_paused = true)]
    async fn drops_clients_that_lose_admission() {
        struct Revocable(AtomicBool);
        #[async_trait::async_trait]
        impl Admission for Revocable {
            async fn admit(&self, _k: &[u8; 32]) -> Option<Scope> {
                self.0.load(Ordering::Relaxed).then_some(Scope { tenant: [0; 16], parent: None })
            }
        }
        let adm = Arc::new(Revocable(AtomicBool::new(true)));
        let s = server(adm.clone());
        let _a = TestClient::connect(&s, 1).await.unwrap();
        wait_for_clients(&s, 1).await;
        adm.0.store(false, Ordering::Relaxed);
        tokio::time::sleep(KEEP_ALIVE + Duration::from_secs(10)).await;
        wait_for_clients(&s, 0).await;
    }
}

#[cfg(test)]
mod local_client_tests {
    use super::*;

    fn scope(t: u8) -> Scope {
        Scope { tenant: [t; 16], parent: None }
    }

    #[tokio::test]
    async fn local_clients_exchange_packets_inside_a_scope_only() {
        let server = Arc::new(DerpServer::new([7; 32], Arc::new(AllowAll), DerpConfig::default()));
        let a = server.attach_local([1; 32], scope(1));
        let b = server.attach_local([2; 32], scope(1));
        let other = server.attach_local([3; 32], scope(2));
        assert_eq!(server.connected_clients(), 3);

        a.send([2; 32], Bytes::from_static(b"hello"));
        assert_eq!(b.recv().await, Some(([1; 32], Bytes::from_static(b"hello"))));

        // Another tenant's client is unreachable, like an unknown key
        a.send([3; 32], Bytes::from_static(b"nope"));
        b.send([1; 32], Bytes::from_static(b"reply"));
        assert_eq!(a.recv().await, Some(([2; 32], Bytes::from_static(b"reply"))));
        assert!(tokio::time::timeout(Duration::from_millis(30), other.recv()).await.is_err());

        drop(b);
        assert_eq!(server.connected_clients(), 2);
    }

    #[tokio::test]
    async fn a_waiting_local_client_wakes_when_a_packet_arrives() {
        let server = Arc::new(DerpServer::new([7; 32], Arc::new(AllowAll), DerpConfig::default()));
        let a = server.attach_local([1; 32], scope(1));
        let b = Arc::new(server.attach_local([2; 32], scope(1)));
        let waiter = {
            let b = b.clone();
            tokio::spawn(async move { b.recv().await })
        };
        tokio::task::yield_now().await;
        a.send([2; 32], Bytes::from_static(b"late"));
        assert_eq!(waiter.await.unwrap(), Some(([1; 32], Bytes::from_static(b"late"))));
    }
}
