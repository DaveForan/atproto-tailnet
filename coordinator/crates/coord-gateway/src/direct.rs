//! One UDP socket for the gateways of all tailnets (ADR-0029 phase 2).
//! Security: each datagram is input from the internet. The work for one datagram has a fixed bound,
//! and this module sends no answer. A gateway answers only after it checks the sender.

use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use tokio::net::UdpSocket;
use tokio::sync::mpsc;
use tracing::debug;

use crate::disco;

/// Longer datagrams are dropped. A WireGuard packet of a tailnet is below 1500 bytes.
pub const MAX_DATAGRAM: usize = 2048;
/// Datagrams that wait for one gateway. More are dropped.
const QUEUE: usize = 1024;
/// A handshake initiation is accepted from an address this long after the last valid disco ping from it.
pub const ADDRESS_TRUST: Duration = Duration::from_secs(120);
const MAX_TRUSTED_ADDRESSES: usize = 65_536;
/// One disco key can be a device in more than one tailnet. A packet is offered to this many gateways at most.
const MAX_GATEWAYS_PER_DISCO_KEY: usize = 4;
/// Disco and handshake packets from one source address, each second. Data packets have no limit here.
const SOURCE_RATE: f64 = 50.0;
const SOURCE_BURST: f64 = 100.0;
const MAX_SOURCES: usize = 8192;
const INDEX_MASK: u32 = 0x00ff_ffff;

/// A datagram for one gateway.
pub struct Datagram {
    pub from: SocketAddr,
    pub data: Bytes,
}

#[derive(Debug, PartialEq, Eq)]
enum Kind {
    Disco([u8; 32]),
    /// A WireGuard handshake initiation. It has no receiver identity in clear text.
    Initiation,
    /// A WireGuard packet with the receiver's session index.
    Indexed { index: u32, handshake: bool },
}

fn classify(data: &[u8]) -> Option<Kind> {
    if let Some(key) = disco::sender(data) {
        return Some(Kind::Disco(key));
    }
    let word = |at: usize| data.get(at..at + 4).and_then(|b| b.try_into().ok()).map(u32::from_le_bytes);
    // WireGuard: a type byte and three zero bytes, then fixed sizes for all but data.
    match (word(0)?, data.len()) {
        (1, 148) => Some(Kind::Initiation),
        (2, 92) => Some(Kind::Indexed { index: word(8)?, handshake: true }),
        (3, 64) => Some(Kind::Indexed { index: word(4)?, handshake: true }),
        (4, 32..) => Some(Kind::Indexed { index: word(4)?, handshake: false }),
        _ => None,
    }
}

/// A token bucket for each source address.
#[derive(Default)]
struct Sources {
    buckets: HashMap<IpAddr, (f64, Instant)>,
}

impl Sources {
    fn allow(&mut self, source: IpAddr, now: Instant) -> bool {
        // One IPv6 network is one source.
        let source = match source {
            IpAddr::V6(v6) => IpAddr::V6((u128::from(v6) & !0u128 << 64).into()),
            v4 => v4,
        };
        if self.buckets.len() >= MAX_SOURCES && !self.buckets.contains_key(&source) {
            // Forged sources fill the table. A new start keeps real sources usable.
            self.buckets.clear();
        }
        let (tokens, at) = self.buckets.entry(source).or_insert((SOURCE_BURST, now));
        *tokens = (*tokens + now.duration_since(*at).as_secs_f64() * SOURCE_RATE).min(SOURCE_BURST);
        *at = now;
        if *tokens < 1.0 {
            return false;
        }
        *tokens -= 1.0;
        true
    }
}

#[derive(Default)]
struct Routes {
    next_slot: u32,
    next_index: u32,
    gateways: HashMap<u32, mpsc::Sender<Datagram>>,
    by_disco: HashMap<[u8; 32], Vec<u32>>,
    disco_of: HashMap<u32, Vec<[u8; 32]>>,
    by_index: HashMap<u32, u32>,
    by_address: HashMap<SocketAddr, (u32, Instant)>,
}

impl Routes {
    fn forget_disco(&mut self, slot: u32) {
        for key in self.disco_of.remove(&slot).unwrap_or_default() {
            if let Some(slots) = self.by_disco.get_mut(&key) {
                slots.retain(|s| *s != slot);
                if slots.is_empty() {
                    self.by_disco.remove(&key);
                }
            }
        }
    }
}

struct Inner {
    socket: UdpSocket,
    routes: Mutex<Routes>,
}

impl Inner {
    fn routes(&self) -> std::sync::MutexGuard<'_, Routes> {
        self.routes.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn route(&self, data: &[u8], from: SocketAddr, sources: &mut Sources, now: Instant) {
        let Some(kind) = classify(data) else { return };
        let limited = !matches!(kind, Kind::Indexed { handshake: false, .. });
        if limited && !sources.allow(from.ip(), now) {
            return;
        }
        let routes = self.routes();
        let deliver = |slot: &u32| {
            if let Some(gateway) = routes.gateways.get(slot) {
                let _ = gateway.try_send(Datagram { from, data: Bytes::copy_from_slice(data) });
            }
        };
        match kind {
            Kind::Disco(key) => routes.by_disco.get(&key).into_iter().flatten().take(MAX_GATEWAYS_PER_DISCO_KEY).for_each(deliver),
            Kind::Initiation => {
                if let Some((slot, _)) = routes.by_address.get(&from).filter(|(_, until)| *until > now) {
                    deliver(slot);
                }
            }
            // The session index is in the high 24 bits. The low byte counts the key rotations.
            Kind::Indexed { index, .. } => routes.by_index.get(&(index >> 8)).into_iter().for_each(deliver),
        }
    }
}

async fn receive(inner: Arc<Inner>) {
    let mut buf = vec![0u8; MAX_DATAGRAM + 1];
    let mut sources = Sources::default();
    loop {
        match inner.socket.recv_from(&mut buf).await {
            Ok((len, from)) if len <= MAX_DATAGRAM => {
                let from = SocketAddr::new(from.ip().to_canonical(), from.port());
                inner.route(&buf[..len], from, &mut sources, Instant::now());
            }
            Ok(_) => {}
            Err(e) => {
                debug!(error = %e, "gateway UDP socket: receive failed");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
    }
}

/// The UDP socket of the gateways in this process. Dropping it stops the receive task.
pub struct DirectSocket {
    inner: Arc<Inner>,
    task: tokio::task::JoinHandle<()>,
}

impl DirectSocket {
    pub async fn bind(addr: SocketAddr) -> io::Result<Self> {
        let socket = UdpSocket::bind(addr).await?;
        let routes = Routes { next_index: rand::random::<u32>() & INDEX_MASK, ..Default::default() };
        let inner = Arc::new(Inner { socket, routes: Mutex::new(routes) });
        let task = tokio::spawn(receive(inner.clone()));
        Ok(Self { inner, task })
    }

    pub fn local_addr(&self) -> io::Result<SocketAddr> {
        self.inner.socket.local_addr()
    }

    /// Adds one gateway. It gets no packets until it names disco keys, indexes or addresses.
    pub fn attach(&self) -> DirectPort {
        let (tx, rx) = mpsc::channel(QUEUE);
        let mut routes = self.inner.routes();
        routes.next_slot += 1;
        let slot = routes.next_slot;
        routes.gateways.insert(slot, tx);
        DirectPort { inner: self.inner.clone(), slot, rx }
    }
}

impl Drop for DirectSocket {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// The part of the shared socket that one gateway uses. Dropping it removes the gateway from the socket.
pub struct DirectPort {
    inner: Arc<Inner>,
    slot: u32,
    rx: mpsc::Receiver<Datagram>,
}

impl DirectPort {
    pub async fn recv(&mut self) -> Option<Datagram> {
        self.rx.recv().await
    }

    /// Sends without waiting. A datagram that the socket cannot take now is lost, as on any UDP path.
    pub fn send(&self, to: SocketAddr, data: &[u8]) {
        let to = match (to.ip(), self.inner.socket.local_addr()) {
            (IpAddr::V4(v4), Ok(local)) if local.is_ipv6() => SocketAddr::new(IpAddr::V6(v4.to_ipv6_mapped()), to.port()),
            _ => to,
        };
        let _ = self.inner.socket.try_send_to(data, to);
    }

    /// Names the disco keys whose packets this gateway wants. Replaces the keys named before.
    pub fn set_disco_keys(&self, keys: Vec<[u8; 32]>) {
        let mut routes = self.inner.routes();
        routes.forget_disco(self.slot);
        for key in &keys {
            let slots = routes.by_disco.entry(*key).or_default();
            if !slots.contains(&self.slot) {
                slots.push(self.slot);
            }
        }
        routes.disco_of.insert(self.slot, keys);
    }

    /// A WireGuard session index that no other session on the socket has. `None` when none is free.
    pub fn allocate_index(&self) -> Option<u32> {
        let mut routes = self.inner.routes();
        for _ in 0..64 {
            routes.next_index = (routes.next_index + 1) & INDEX_MASK;
            let index = routes.next_index;
            if let std::collections::hash_map::Entry::Vacant(free) = routes.by_index.entry(index) {
                free.insert(self.slot);
                return Some(index);
            }
        }
        None
    }

    pub fn release_index(&self, index: u32) {
        let mut routes = self.inner.routes();
        if routes.by_index.get(&index) == Some(&self.slot) {
            routes.by_index.remove(&index);
        }
    }

    /// Lets handshake initiations from `addr` reach this gateway for [`ADDRESS_TRUST`].
    /// Call it only for an address that sent a valid disco ping. Returns false when the table is full.
    pub fn trust_address(&self, addr: SocketAddr) -> bool {
        let now = Instant::now();
        let mut routes = self.inner.routes();
        if routes.by_address.len() >= MAX_TRUSTED_ADDRESSES && !routes.by_address.contains_key(&addr) {
            routes.by_address.retain(|_, (_, until)| *until > now);
            if routes.by_address.len() >= MAX_TRUSTED_ADDRESSES {
                return false;
            }
        }
        routes.by_address.insert(addr, (self.slot, now + ADDRESS_TRUST));
        true
    }
}

impl Drop for DirectPort {
    fn drop(&mut self) {
        let slot = self.slot;
        let mut routes = self.inner.routes();
        routes.gateways.remove(&slot);
        routes.forget_disco(slot);
        routes.by_index.retain(|_, s| *s != slot);
        routes.by_address.retain(|_, (s, _)| *s != slot);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::disco::{Channel, Message};

    const WAIT: Duration = Duration::from_millis(150);

    async fn pair() -> (DirectSocket, UdpSocket, SocketAddr) {
        let socket = DirectSocket::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
        let to = socket.local_addr().unwrap();
        let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        (socket, client, to)
    }

    async fn next(port: &mut DirectPort) -> Option<Bytes> {
        tokio::time::timeout(WAIT, port.recv()).await.ok().flatten().map(|d| d.data)
    }

    fn wireguard(kind: u8, len: usize, index_at: Option<usize>, index: u32) -> Vec<u8> {
        let mut packet = vec![0u8; len];
        packet[0] = kind;
        if let Some(at) = index_at {
            packet[at..at + 4].copy_from_slice(&index.to_le_bytes());
        }
        packet
    }

    #[test]
    fn packets_are_classified_by_form_only() {
        assert_eq!(classify(&wireguard(1, 148, None, 0)), Some(Kind::Initiation));
        assert_eq!(classify(&wireguard(1, 147, None, 0)), None);
        assert_eq!(classify(&wireguard(2, 92, Some(8), 0x0102_0304)), Some(Kind::Indexed { index: 0x0102_0304, handshake: true }));
        assert_eq!(classify(&wireguard(3, 64, Some(4), 7)), Some(Kind::Indexed { index: 7, handshake: true }));
        assert_eq!(classify(&wireguard(4, 32, Some(4), 9)), Some(Kind::Indexed { index: 9, handshake: false }));
        assert_eq!(classify(&wireguard(4, 31, Some(4), 9)), None);
        assert_eq!(classify(&wireguard(5, 64, None, 0)), None);
        let mut reserved = wireguard(4, 64, Some(4), 9);
        reserved[2] = 1;
        assert_eq!(classify(&reserved), None, "the reserved bytes are zero");
        assert_eq!(classify(&[]), None);
        let ping = Channel::new(&[1; 32], &disco::public_key(&[2; 32])).seal(&Message::Ping { tx: [0; 12], node_key: None }, [0; 24]);
        assert_eq!(classify(&ping), Some(Kind::Disco(disco::public_key(&[1; 32]))));
    }

    #[test]
    fn one_source_gets_a_burst_and_then_a_rate() {
        let mut sources = Sources::default();
        let start = Instant::now();
        let (a, b): (IpAddr, IpAddr) = ("192.0.2.1".parse().unwrap(), "192.0.2.2".parse().unwrap());
        let allowed = (0..1000).filter(|_| sources.allow(a, start)).count();
        assert_eq!(allowed, SOURCE_BURST as usize);
        assert!(sources.allow(b, start), "another source has its own bucket");
        assert!(!sources.allow(a, start));
        let later = start + Duration::from_secs(1);
        assert_eq!((0..1000).filter(|_| sources.allow(a, later)).count(), SOURCE_RATE as usize);
        // Addresses in one IPv6 /64 share a bucket.
        let (x, y): (IpAddr, IpAddr) = ("2001:db8::1".parse().unwrap(), "2001:db8::ffff:2".parse().unwrap());
        assert_eq!((0..1000).filter(|_| sources.allow(x, start)).count(), SOURCE_BURST as usize);
        assert!(!sources.allow(y, start));
    }

    #[tokio::test]
    async fn disco_goes_only_to_gateways_that_named_the_sender() {
        let (socket, client, to) = pair().await;
        let (mut first, mut second) = (socket.attach(), socket.attach());
        let known = disco::public_key(&[1; 32]);
        first.set_disco_keys(vec![known]);
        let ping = |secret: [u8; 32]| Channel::new(&secret, &[9; 32]).seal(&Message::Ping { tx: [0; 12], node_key: None }, [0; 24]);

        client.send_to(&ping([1; 32]), to).await.unwrap();
        assert_eq!(next(&mut first).await.as_deref(), Some(&ping([1; 32])[..]));
        assert!(next(&mut second).await.is_none());

        client.send_to(&ping([7; 32]), to).await.unwrap();
        assert!(next(&mut first).await.is_none(), "an unknown disco key reaches no gateway");

        // A new list replaces the old one.
        first.set_disco_keys(vec![]);
        second.set_disco_keys(vec![known]);
        client.send_to(&ping([1; 32]), to).await.unwrap();
        assert!(next(&mut second).await.is_some());
        assert!(next(&mut first).await.is_none());
    }

    #[tokio::test]
    async fn wireguard_goes_by_session_index_and_initiations_by_trusted_address() {
        let (socket, client, to) = pair().await;
        let (mut first, mut second) = (socket.attach(), socket.attach());
        let (a, b) = (first.allocate_index().unwrap(), second.allocate_index().unwrap());
        assert_ne!(a, b, "an index belongs to one gateway");

        client.send_to(&wireguard(4, 48, Some(4), a << 8 | 3), to).await.unwrap();
        assert!(next(&mut first).await.is_some());
        client.send_to(&wireguard(2, 92, Some(8), b << 8), to).await.unwrap();
        assert!(next(&mut second).await.is_some());
        assert!(next(&mut first).await.is_none());

        second.release_index(a);
        client.send_to(&wireguard(4, 48, Some(4), a << 8), to).await.unwrap();
        assert!(next(&mut first).await.is_some(), "only the owner releases an index");
        first.release_index(a);
        client.send_to(&wireguard(4, 48, Some(4), a << 8), to).await.unwrap();
        assert!(next(&mut first).await.is_none());

        // An initiation names no receiver: only an address that a gateway trusts gets through.
        client.send_to(&wireguard(1, 148, None, 0), to).await.unwrap();
        assert!(next(&mut first).await.is_none() && next(&mut second).await.is_none());
        assert!(second.trust_address(client.local_addr().unwrap()));
        client.send_to(&wireguard(1, 148, None, 0), to).await.unwrap();
        assert!(next(&mut second).await.is_some());
        assert!(next(&mut first).await.is_none());

        // Garbage and datagrams that are too long reach no gateway.
        client.send_to(&[0xff; 64], to).await.unwrap();
        client.send_to(&wireguard(4, MAX_DATAGRAM + 1, Some(4), b << 8), to).await.unwrap();
        assert!(next(&mut second).await.is_none());
    }

    #[tokio::test]
    async fn handshake_packets_of_one_source_are_limited() {
        let (socket, client, to) = pair().await;
        let mut port = socket.attach();
        assert!(port.trust_address(client.local_addr().unwrap()));
        for _ in 0..400 {
            client.send_to(&wireguard(1, 148, None, 0), to).await.unwrap();
        }
        let mut got = 0;
        while next(&mut port).await.is_some() {
            got += 1;
        }
        assert!((1..=SOURCE_BURST as usize + 50).contains(&got), "{got} initiations passed");
    }

    #[tokio::test]
    async fn a_dropped_gateway_leaves_the_socket() {
        let (socket, client, _) = pair().await;
        let port = socket.attach();
        let index = port.allocate_index().unwrap();
        port.set_disco_keys(vec![[1; 32]]);
        port.trust_address(client.local_addr().unwrap());
        drop(port);
        let routes = socket.inner.routes();
        assert!(routes.gateways.is_empty() && routes.by_disco.is_empty() && routes.disco_of.is_empty());
        assert!(routes.by_address.is_empty() && !routes.by_index.contains_key(&index));
    }
}
