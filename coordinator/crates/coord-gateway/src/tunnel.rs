//! The gateway's WireGuard side in one tailnet (ADR-0029).
//! Packets use the in-process relay (ADR-0027). With direct paths on, they also use the shared UDP socket.
//! Security: a decrypted packet must carry its sender's tailnet address, so no device can spoof another.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use boringtun::noise::errors::WireGuardError;
use boringtun::noise::handshake::parse_handshake_anon;
use boringtun::noise::{Packet, Tunn, TunnResult};
use boringtun::x25519::{PublicKey, StaticSecret};
use bytes::Bytes;
use coord_derp::LocalClient;
use tokio::sync::{mpsc, Notify};
use tracing::debug;

use crate::direct::{Datagram, DirectPort, ADDRESS_TRUST};
use crate::disco::{self, Channel, Message};
use crate::netstack::NetStack;

/// WireGuard adds at most 32 bytes to a data packet; handshakes are 148.
const WG_BUFFER: usize = 2048;
const TIMER_TICK: Duration = Duration::from_millis(250);
/// Lifetime of a cached directory answer.
/// [`Devices::changes`] clears the cache at once; this bound covers lost notices, for example from another replica.
pub const DIRECTORY_TTL: Duration = Duration::from_secs(10);
/// A session with no traffic for this long is forgotten.
const IDLE_SESSION: Duration = Duration::from_secs(10 * 60);
/// Sessions per tailnet. Each node key has at most one session.
/// The per-device connection limit is [`crate::netstack::MAX_CONNECTIONS_PER_PEER`].
pub const MAX_SESSIONS: usize = 4096;
/// A direct path with no authenticated packet for this long is not used. The relay takes over.
pub const DIRECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Lifetime of the list of disco keys. [`Devices::changes`] renews it at once.
const DISCO_TTL: Duration = Duration::from_secs(60);
/// Pongs for one device, each second.
const PONG_RATE: f64 = 20.0;
const PONG_BURST: f64 = 40.0;
/// In a pong through a relay, clients expect this address with the relay region as the port.
const RELAY_PONG_ADDR: Ipv4Addr = Ipv4Addr::new(127, 3, 3, 40);

/// The gateway's directory of its tailnet's devices. The coordinator answers from its store.
#[async_trait::async_trait]
pub trait Devices: Send + Sync + 'static {
    /// The tailnet address for this node key, if the key is a device of this tailnet.
    async fn addr_of(&self, node_key: &[u8; 32]) -> Option<Ipv4Addr>;
    /// The node key of the device with this tailnet address.
    async fn key_of(&self, addr: Ipv4Addr) -> Option<[u8; 32]>;
    /// The disco key and the node key of each device that can reach the gateway.
    async fn disco_keys(&self) -> Vec<([u8; 32], [u8; 32])> {
        Vec::new()
    }
    /// Fires when a device joins, leaves, or changes key or address.
    /// The gateway then drops cached answers, so the change applies at once.
    /// `None` keeps answers for [`DIRECTORY_TTL`].
    fn changes(&self) -> Option<Arc<Notify>> {
        None
    }
}

/// What one gateway needs for direct paths (ADR-0029 phase 2).
pub struct Direct {
    pub port: DirectPort,
    /// The secret half of the disco key in the gateway's node record.
    pub disco_secret: [u8; 32],
    /// The DERP region of the relay in this process.
    pub relay_region: u16,
}

/// Where the last authenticated packet of a device came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Path {
    Relay,
    Direct { addr: SocketAddr, heard: Instant },
}

impl Path {
    /// The UDP address to send to at `now`. `None` = send through the relay.
    fn direct_at(&self, now: Instant) -> Option<SocketAddr> {
        match *self {
            Path::Direct { addr, heard } if now.saturating_duration_since(heard) < DIRECT_TIMEOUT => Some(addr),
            _ => None,
        }
    }
}

struct Session {
    tunn: Tunn,
    addr: Ipv4Addr,
    last_used: Instant,
    index: u32,
    path: Path,
}

struct Cached<T> {
    value: Option<T>,
    at: Instant,
}

struct DiscoPeer {
    node_key: [u8; 32],
    /// Made on the first packet, because it costs one X25519 operation.
    channel: Option<Channel>,
    pongs: f64,
    refilled: Instant,
}

/// Direct-path state of one gateway.
struct DirectState {
    port: DirectPort,
    disco_secret: [u8; 32],
    relay_region: u16,
    peers: HashMap<[u8; 32], DiscoPeer>,
    peers_at: Instant,
    /// UDP addresses that sent a valid disco ping, with the node key of the sender.
    addresses: HashMap<SocketAddr, ([u8; 32], Instant)>,
    by_index: HashMap<u32, [u8; 32]>,
}

/// How a packet came in.
#[derive(Clone, Copy)]
enum Via {
    Relay([u8; 32]),
    Udp(SocketAddr),
}

/// The gateway in one tailnet: a relay client, WireGuard sessions, and a TCP/IP stack.
/// It stops when every clone of the returned stack handle is dropped.
pub struct Tailnet {
    secret: StaticSecret,
    relay: LocalClient,
    devices: Arc<dyn Devices>,
    stack: NetStack,
    sessions: HashMap<[u8; 32], Session>,
    by_key: HashMap<[u8; 32], Cached<Ipv4Addr>>,
    by_addr: HashMap<Ipv4Addr, Cached<[u8; 32]>>,
    next_index: u32,
    /// `None`: the gateway ignores disco and uses the relay only.
    direct: Option<DirectState>,
}

impl Tailnet {
    /// Joins a tailnet with node key `secret` and tailnet address `addr`.
    /// `relay` must be attached with the public half of `secret`.
    pub fn spawn(secret: [u8; 32], addr: Ipv4Addr, relay: LocalClient, devices: Arc<dyn Devices>) -> NetStack {
        Self::spawn_with(secret, addr, relay, devices, None)
    }

    /// As [`Tailnet::spawn`]. With `direct`, the gateway also answers disco pings and uses UDP paths.
    pub fn spawn_with(secret: [u8; 32], addr: Ipv4Addr, relay: LocalClient, devices: Arc<dyn Devices>, direct: Option<Direct>) -> NetStack {
        let (out, out_rx) = mpsc::channel(1024);
        let stack = NetStack::spawn(addr, out);
        let tailnet = Tailnet {
            secret: StaticSecret::from(secret),
            relay,
            devices,
            stack: stack.clone(),
            sessions: HashMap::new(),
            by_key: HashMap::new(),
            by_addr: HashMap::new(),
            next_index: rand::random::<u32>() >> 8,
            direct: direct.map(|d| DirectState {
                port: d.port,
                disco_secret: d.disco_secret,
                relay_region: d.relay_region,
                peers: HashMap::new(),
                peers_at: Instant::now(),
                addresses: HashMap::new(),
                by_index: HashMap::new(),
            }),
        };
        tokio::spawn(tailnet.run(out_rx));
        stack
    }

    async fn run(mut self, mut out: mpsc::Receiver<Vec<u8>>) {
        let mut tick = tokio::time::interval(TIMER_TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut buf = vec![0u8; WG_BUFFER];
        let changes = self.devices.changes();
        self.load_disco_keys().await;
        loop {
            let changed = async {
                match &changes {
                    Some(n) => n.notified().await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                _ = changed => {
                    self.forget_directory();
                    self.load_disco_keys().await;
                }
                received = self.relay.recv() => match received {
                    Some((from, data)) => self.handle_device_packet(from, &data, &mut buf).await,
                    None => return, // another client took our key: this instance is over
                },
                datagram = next_datagram(&mut self.direct) => self.handle_datagram(datagram, &mut buf).await,
                packet = out.recv() => match packet {
                    Some(packet) => self.send_to_device(&packet, &mut buf).await,
                    None => return, // the stack stopped
                },
                _ = tick.tick() => {
                    self.timers(&mut buf);
                    if self.direct.as_ref().is_some_and(|d| d.peers_at.elapsed() > DISCO_TTL) {
                        self.load_disco_keys().await;
                    }
                }
            }
        }
    }

    /// Drops all cached directory answers.
    /// Sessions stay, because each packet re-checks its sender with the directory.
    fn forget_directory(&mut self) {
        self.by_key.clear();
        self.by_addr.clear();
    }

    /// Reads the disco keys of the devices again, and tells the socket which keys to route here.
    async fn load_disco_keys(&mut self) {
        let Some(direct) = &mut self.direct else { return };
        let mut keys = self.devices.disco_keys().await;
        keys.truncate(4 * MAX_SESSIONS);
        let now = Instant::now();
        let mut old = std::mem::take(&mut direct.peers);
        for (disco_key, node_key) in keys {
            let peer = match old.remove(&disco_key) {
                Some(peer) if peer.node_key == node_key => peer,
                _ => DiscoPeer { node_key, channel: None, pongs: PONG_BURST, refilled: now },
            };
            direct.peers.insert(disco_key, peer);
        }
        direct.peers_at = now;
        direct.port.set_disco_keys(direct.peers.keys().copied().collect());
        // An address stays only while its device stays.
        let peers = &direct.peers;
        direct.addresses.retain(|_, (node_key, at)| at.elapsed() < ADDRESS_TRUST && peers.values().any(|p| p.node_key == *node_key));
    }

    async fn addr_of(&mut self, key: &[u8; 32]) -> Option<Ipv4Addr> {
        if let Some(c) = self.by_key.get(key).filter(|c| c.at.elapsed() < DIRECTORY_TTL) {
            return c.value;
        }
        let value = self.devices.addr_of(key).await;
        if self.by_key.len() >= 4 * MAX_SESSIONS {
            self.by_key.clear();
        }
        self.by_key.insert(*key, Cached { value, at: Instant::now() });
        value
    }

    async fn key_of(&mut self, addr: Ipv4Addr) -> Option<[u8; 32]> {
        if let Some(c) = self.by_addr.get(&addr).filter(|c| c.at.elapsed() < DIRECTORY_TTL) {
            return c.value;
        }
        let value = self.devices.key_of(addr).await;
        if self.by_addr.len() >= 4 * MAX_SESSIONS {
            self.by_addr.clear();
        }
        self.by_addr.insert(addr, Cached { value, at: Instant::now() });
        value
    }

    /// Handles a packet that a device sent through the relay. The relay proved the node key `from`.
    async fn handle_device_packet(&mut self, from: [u8; 32], data: &[u8], buf: &mut [u8]) {
        if data.starts_with(disco::MAGIC) {
            self.handle_disco(Via::Relay(from), data);
            return;
        }
        self.handle_wireguard(from, None, data, buf).await;
    }

    /// Handles a datagram from the shared UDP socket. Nothing proves its sender yet.
    async fn handle_datagram(&mut self, datagram: Datagram, buf: &mut [u8]) {
        let Datagram { from, data } = datagram;
        if data.starts_with(disco::MAGIC) {
            self.handle_disco(Via::Udp(from), &data);
            return;
        }
        let Some(direct) = &self.direct else { return };
        // WireGuard finds the peer of a session by index. An initiation has no index and hides its sender:
        // only an address that sent a valid disco ping gets the key operations that find the sender.
        let key = match data.first() {
            Some(1) => direct.addresses.get(&from).filter(|(_, at)| at.elapsed() < ADDRESS_TRUST).and_then(|_| match Tunn::parse_incoming_packet(&data) {
                Ok(Packet::HandshakeInit(initiation)) => parse_handshake_anon(&self.secret, &PublicKey::from(&self.secret), &initiation).ok().map(|h| h.peer_static_public),
                _ => None,
            }),
            Some(2) => index_at(&data, 8).and_then(|i| direct.by_index.get(&i).copied()),
            _ => index_at(&data, 4).and_then(|i| direct.by_index.get(&i).copied()),
        };
        let Some(key) = key else { return };
        self.handle_wireguard(key, Some(from), &data, buf).await;
    }

    /// Answers a disco ping from a device of this tailnet, on the path the ping came on.
    fn handle_disco(&mut self, via: Via, data: &[u8]) {
        let Some(direct) = &mut self.direct else { return };
        let Some(sender) = disco::sender(data) else { return };
        let Some(peer) = direct.peers.get_mut(&sender) else {
            return; // not a device that can reach this gateway
        };
        if let Via::Relay(node_key) = via
            && node_key != peer.node_key
        {
            return;
        }
        let channel = peer.channel.get_or_insert_with(|| Channel::new(&direct.disco_secret, &sender));
        let Some(Message::Ping { tx, node_key }) = channel.open(data) else {
            return; // the gateway starts no pings, so it expects no pong and needs no call-me-maybe
        };
        let named = match via {
            // The node key makes a UDP ping longer than its pong, so a forged source address gains nothing.
            Via::Udp(_) => node_key == Some(peer.node_key),
            Via::Relay(_) => node_key.is_none_or(|k| k == peer.node_key),
        };
        if !named {
            return;
        }
        let now = Instant::now();
        peer.pongs = (peer.pongs + now.saturating_duration_since(peer.refilled).as_secs_f64() * PONG_RATE).min(PONG_BURST);
        peer.refilled = now;
        if peer.pongs < 1.0 {
            return;
        }
        peer.pongs -= 1.0;
        let src = match via {
            Via::Udp(addr) => addr,
            Via::Relay(_) => SocketAddr::new(IpAddr::V4(RELAY_PONG_ADDR), direct.relay_region),
        };
        let pong = channel.seal(&Message::Pong { tx, src }, rand::random());
        match via {
            Via::Relay(node_key) => self.relay.send(node_key, Bytes::from(pong)),
            Via::Udp(addr) => {
                if pong.len() > data.len() {
                    return;
                }
                let node_key = peer.node_key;
                if direct.addresses.len() >= MAX_SESSIONS && !direct.addresses.contains_key(&addr) {
                    direct.addresses.retain(|_, (_, at)| at.elapsed() < ADDRESS_TRUST);
                    if direct.addresses.len() >= MAX_SESSIONS {
                        return;
                    }
                }
                if !direct.port.trust_address(addr) {
                    return;
                }
                direct.addresses.insert(addr, (node_key, now));
                direct.port.send(addr, &pong);
                // A ping proves that the device is still at the address its session uses.
                if let Some(Session { path: Path::Direct { addr: current, heard }, .. }) = self.sessions.get_mut(&node_key)
                    && *current == addr
                {
                    *heard = now;
                }
            }
        }
    }

    /// Handles a WireGuard packet for the session with the device `from`.
    /// `source` is the UDP address it came from, or `None` for the relay.
    async fn handle_wireguard(&mut self, from: [u8; 32], source: Option<SocketAddr>, data: &[u8], buf: &mut [u8]) {
        let Some(addr) = self.addr_of(&from).await else {
            return; // not a device of this tailnet
        };
        let stack = self.stack.clone();
        let Some(session) = session(&mut self.sessions, &self.secret, &mut self.next_index, self.direct.as_mut(), from, addr) else { return };
        let port = self.direct.as_ref().map(|d| &d.port);
        let mut input: &[u8] = data;
        loop {
            let result = session.tunn.decapsulate(source.map(|s| s.ip()), input, buf);
            if !input.is_empty() && proves_sender(data[0], &result) {
                session.path = match source {
                    Some(addr) => Path::Direct { addr, heard: Instant::now() },
                    None => Path::Relay,
                };
            }
            match result {
                TunnResult::WriteToNetwork(reply) => {
                    // The answer to a packet goes back the way the packet came: a cookie reply
                    // has no other way. Packets that waited for the handshake use the session's path.
                    let to = if input.is_empty() { session.path.direct_at(Instant::now()) } else { source };
                    transmit(&self.relay, port, to, from, reply);
                    // Empty input flushes packets that waited for the handshake.
                    input = &[];
                    continue;
                }
                TunnResult::WriteToTunnelV4(packet, source) => {
                    session.last_used = Instant::now();
                    if source == session.addr {
                        stack.inject(packet.to_vec());
                    } else {
                        debug!(%source, expected = %session.addr, "dropped a packet with a source address that is not the sender's");
                    }
                }
                // Tailnets carry no IPv6.
                TunnResult::WriteToTunnelV6(..) | TunnResult::Done => {}
                TunnResult::Err(e) => debug!(error = ?e, "WireGuard packet refused"),
            }
            break;
        }
    }

    /// Encrypts an IP packet from the stack for its destination device.
    async fn send_to_device(&mut self, packet: &[u8], buf: &mut [u8]) {
        if packet.len() < 20 || packet[0] >> 4 != 4 {
            return;
        }
        let dst = Ipv4Addr::new(packet[16], packet[17], packet[18], packet[19]);
        let Some(key) = self.key_of(dst).await else {
            return; // no such device: the packet has nowhere to go
        };
        let Some(session) = session(&mut self.sessions, &self.secret, &mut self.next_index, self.direct.as_mut(), key, dst) else { return };
        session.last_used = Instant::now();
        let to = session.path.direct_at(Instant::now());
        match session.tunn.encapsulate(packet, buf) {
            // The encrypted packet, or a handshake while the packet waits in the session.
            TunnResult::WriteToNetwork(data) => transmit(&self.relay, self.direct.as_ref().map(|d| &d.port), to, key, data),
            TunnResult::Err(e) => debug!(error = ?e, "could not encrypt a packet"),
            _ => {}
        }
    }

    /// WireGuard timers: handshake retries, key rotation, keep-alives.
    fn timers(&mut self, buf: &mut [u8]) {
        let mut gone = Vec::new();
        let now = Instant::now();
        for (key, session) in &mut self.sessions {
            if session.last_used.elapsed() > IDLE_SESSION {
                gone.push(*key);
                continue;
            }
            match session.tunn.update_timers(buf) {
                TunnResult::WriteToNetwork(data) => transmit(&self.relay, self.direct.as_ref().map(|d| &d.port), session.path.direct_at(now), *key, data),
                TunnResult::Err(WireGuardError::ConnectionExpired) => gone.push(*key),
                _ => {}
            }
        }
        for key in gone {
            if let (Some(session), Some(direct)) = (self.sessions.remove(&key), &mut self.direct) {
                direct.by_index.remove(&session.index);
                direct.port.release_index(session.index);
            }
        }
    }
}

/// The next datagram of the shared socket. Waits forever when direct paths are off.
async fn next_datagram(direct: &mut Option<DirectState>) -> Datagram {
    if let Some(direct) = direct
        && let Some(datagram) = direct.port.recv().await
    {
        return datagram;
    }
    std::future::pending().await
}

/// The gateway's session index in a WireGuard packet: the high 24 bits of the receiver index.
fn index_at(data: &[u8], at: usize) -> Option<u32> {
    let bytes: [u8; 4] = data.get(at..at + 4)?.try_into().ok()?;
    Some(u32::from_le_bytes(bytes) >> 8)
}

/// True when `result` shows that the peer of the session made the packet of type `kind`.
/// A cookie reply (type 3) proves nothing about the peer.
fn proves_sender(kind: u8, result: &TunnResult) -> bool {
    match (kind, result) {
        // A valid initiation gets a response (type 2). Under load it gets a cookie reply instead.
        (1, TunnResult::WriteToNetwork(reply)) => reply.first() == Some(&2),
        // A valid response gets a keep-alive data packet.
        (2, TunnResult::WriteToNetwork(reply)) => reply.first() == Some(&4),
        // A data packet that decrypts. `Done` is a keep-alive.
        (4, TunnResult::WriteToTunnelV4(..) | TunnResult::WriteToTunnelV6(..) | TunnResult::Done) => true,
        _ => false,
    }
}

/// Sends a WireGuard packet to a device: to its UDP address, or through the relay.
fn transmit(relay: &LocalClient, port: Option<&DirectPort>, to: Option<SocketAddr>, key: [u8; 32], data: &[u8]) {
    match (port, to) {
        (Some(port), Some(addr)) => port.send(addr, data),
        _ => relay.send(key, Bytes::copy_from_slice(data)),
    }
}

/// Returns the session with a device, and creates it on the first packet.
fn session<'a>(
    sessions: &'a mut HashMap<[u8; 32], Session>,
    secret: &StaticSecret,
    next_index: &mut u32,
    direct: Option<&mut DirectState>,
    key: [u8; 32],
    addr: Ipv4Addr,
) -> Option<&'a mut Session> {
    if !sessions.contains_key(&key) {
        if sessions.len() >= MAX_SESSIONS {
            return None;
        }
        let index = match direct {
            // The shared socket finds the gateway by this index, so no two gateways can have the same.
            Some(direct) => {
                let index = direct.port.allocate_index()?;
                direct.by_index.insert(index, key);
                index
            }
            None => {
                *next_index = (*next_index + 1) & 0x00ff_ffff;
                *next_index
            }
        };
        let tunn = Tunn::new(secret.clone(), PublicKey::from(key), None, None, index, None);
        sessions.insert(key, Session { tunn, addr, last_used: Instant::now(), index, path: Path::Relay });
    }
    let session = sessions.get_mut(&key)?;
    session.addr = addr; // the directory is the authority on addresses
    Some(session)
}

/// The public half of a node key.
pub fn public_key(secret: &[u8; 32]) -> [u8; 32] {
    *PublicKey::from(&StaticSecret::from(*secret)).as_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::netstack::Accepted;
    use coord_derp::{AllowAll, DerpConfig, DerpServer, Scope};
    use std::net::SocketAddrV4;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// A tailnet of fixed devices.
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

    const GATEWAY: Ipv4Addr = Ipv4Addr::new(100, 64, 0, 1);
    const DEVICE: Ipv4Addr = Ipv4Addr::new(100, 64, 0, 2);
    const STRANGER: Ipv4Addr = Ipv4Addr::new(100, 64, 0, 3);

    fn scope() -> Scope {
        Scope { tenant: [1; 16], parent: None }
    }

    #[tokio::test]
    async fn tcp_runs_through_wireguard_and_the_relay_in_both_directions() {
        let relay = Arc::new(DerpServer::new([9; 32], Arc::new(AllowAll), DerpConfig::default()));
        let (gw_secret, dev_secret) = ([11u8; 32], [22u8; 32]);
        let devices = Arc::new(Fixed(vec![(public_key(&gw_secret), GATEWAY), (public_key(&dev_secret), DEVICE)]));
        // The "device" is a second instance of the same code, because WireGuard is symmetric.
        let gateway = Tailnet::spawn(gw_secret, GATEWAY, relay.attach_local(public_key(&gw_secret), scope()), devices.clone());
        let device = Tailnet::spawn(dev_secret, DEVICE, relay.attach_local(public_key(&dev_secret), scope()), devices);

        // Device → gateway (a member opens a service)
        let mut incoming = gateway.listen(443).await.unwrap();
        tokio::spawn(async move {
            while let Some(Accepted { mut stream, peer }) = incoming.recv().await {
                assert_eq!(*peer.ip(), DEVICE);
                let mut buf = [0u8; 5];
                stream.read_exact(&mut buf).await.unwrap();
                stream.write_all(b"world").await.unwrap();
            }
        });
        let mut s = device.connect(SocketAddrV4::new(GATEWAY, 443)).await.unwrap();
        s.write_all(b"hello").await.unwrap();
        let mut buf = [0u8; 5];
        s.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"world");

        // Gateway → device (the gateway reaches the published port), with a large body
        let mut on_device = device.listen(3000).await.unwrap();
        tokio::spawn(async move {
            let Accepted { mut stream, .. } = on_device.recv().await.unwrap();
            let mut all = Vec::new();
            stream.read_to_end(&mut all).await.unwrap();
            stream.write_all(&(all.len() as u32).to_be_bytes()).await.unwrap();
        });
        let mut s = gateway.connect(SocketAddrV4::new(DEVICE, 3000)).await.unwrap();
        s.write_all(&vec![7u8; 300_000]).await.unwrap();
        s.shutdown().await.unwrap();
        let mut len = [0u8; 4];
        s.read_exact(&mut len).await.unwrap();
        assert_eq!(u32::from_be_bytes(len), 300_000);
    }

    /// A directory that can change, and says so.
    struct Changing(std::sync::Mutex<Vec<([u8; 32], Ipv4Addr)>>, Arc<Notify>);

    #[async_trait::async_trait]
    impl Devices for Changing {
        async fn addr_of(&self, key: &[u8; 32]) -> Option<Ipv4Addr> {
            self.0.lock().unwrap().iter().find(|(k, _)| k == key).map(|(_, a)| *a)
        }
        async fn key_of(&self, addr: Ipv4Addr) -> Option<[u8; 32]> {
            self.0.lock().unwrap().iter().find(|(_, a)| *a == addr).map(|(k, _)| *k)
        }
        fn changes(&self) -> Option<Arc<Notify>> {
            Some(self.1.clone())
        }
    }

    #[tokio::test]
    async fn a_removed_device_is_refused_at_once_and_its_address_reaches_the_new_device() {
        let relay = Arc::new(DerpServer::new([9; 32], Arc::new(AllowAll), DerpConfig::default()));
        let (gw_secret, old_secret, new_secret) = ([11u8; 32], [22u8; 32], [44u8; 32]);
        let changed = Arc::new(Notify::new());
        let directory = Arc::new(Changing(
            std::sync::Mutex::new(vec![(public_key(&gw_secret), GATEWAY), (public_key(&old_secret), DEVICE)]),
            changed.clone(),
        ));
        let gateway = Tailnet::spawn(gw_secret, GATEWAY, relay.attach_local(public_key(&gw_secret), scope()), directory.clone());
        let both = |dev: [u8; 32]| Arc::new(Fixed(vec![(public_key(&gw_secret), GATEWAY), (public_key(&dev), DEVICE)]));
        let old = Tailnet::spawn(old_secret, DEVICE, relay.attach_local(public_key(&old_secret), scope()), both(old_secret));
        let mut incoming = gateway.listen(443).await.unwrap();
        tokio::spawn(async move {
            while let Some(Accepted { mut stream, .. }) = incoming.recv().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 1];
                    while stream.read_exact(&mut buf).await.is_ok() {
                        if stream.write_all(&buf).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });
        let mut s = old.connect(SocketAddrV4::new(GATEWAY, 443)).await.unwrap();
        s.write_all(b"a").await.unwrap();
        let mut b = [0u8; 1];
        s.read_exact(&mut b).await.unwrap();

        // The device is removed and a new device gets its address, well within the cache TTL.
        *directory.0.lock().unwrap() = vec![(public_key(&gw_secret), GATEWAY), (public_key(&new_secret), DEVICE)];
        changed.notify_one();
        tokio::time::sleep(Duration::from_millis(50)).await;

        let attempt = tokio::time::timeout(Duration::from_secs(2), old.connect(SocketAddrV4::new(GATEWAY, 443))).await;
        assert!(attempt.is_err() || attempt.unwrap().is_err(), "a removed device must not reach the gateway");
        // The new device at the same address does, both ways
        let new = Tailnet::spawn(new_secret, DEVICE, relay.attach_local(public_key(&new_secret), scope()), both(new_secret));
        // Both emulated stacks pick the same first local port.
        // The gateway still holds the old connection on it, so use the next port.
        let refused = tokio::time::timeout(Duration::from_secs(5), new.connect(SocketAddrV4::new(GATEWAY, 9))).await.unwrap();
        assert!(refused.is_err(), "the new device reaches the gateway (a closed port answers)");
        let mut s = tokio::time::timeout(Duration::from_secs(5), new.connect(SocketAddrV4::new(GATEWAY, 443))).await.unwrap().unwrap();
        s.write_all(b"b").await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), s.read_exact(&mut b)).await.unwrap().unwrap();
        assert_eq!(&b, b"b");
    }

    #[test]
    fn a_direct_path_is_used_only_while_it_is_fresh() {
        let heard = Instant::now();
        let addr: SocketAddr = "203.0.113.9:41641".parse().unwrap();
        let direct = Path::Direct { addr, heard };
        assert_eq!(direct.direct_at(heard), Some(addr));
        assert_eq!(direct.direct_at(heard + DIRECT_TIMEOUT - Duration::from_millis(1)), Some(addr));
        assert_eq!(direct.direct_at(heard + DIRECT_TIMEOUT), None, "a silent direct path gives way to the relay");
        assert_eq!(Path::Relay.direct_at(heard), None);
    }

    #[test]
    fn only_packets_that_the_peer_made_move_the_path() {
        let (mut response, mut cookie, mut keepalive) = ([0u8; 92], [0u8; 64], [0u8; 32]);
        (response[0], cookie[0], keepalive[0]) = (2, 3, 4);
        let mut ip = [0u8; 20];
        assert!(proves_sender(1, &TunnResult::WriteToNetwork(&mut response)));
        assert!(!proves_sender(1, &TunnResult::WriteToNetwork(&mut cookie)), "a cookie reply answers an unproven initiation");
        assert!(proves_sender(2, &TunnResult::WriteToNetwork(&mut keepalive)));
        assert!(!proves_sender(2, &TunnResult::WriteToNetwork(&mut cookie)));
        assert!(proves_sender(4, &TunnResult::Done));
        assert!(proves_sender(4, &TunnResult::WriteToTunnelV4(&mut ip, GATEWAY)));
        assert!(!proves_sender(4, &TunnResult::Err(WireGuardError::InvalidAeadTag)));
        assert!(!proves_sender(3, &TunnResult::Done), "a cookie reply does not prove its sender");
        assert!(!proves_sender(1, &TunnResult::Done));
    }

    #[tokio::test]
    async fn a_key_that_is_not_a_device_of_the_tailnet_gets_no_session() {
        let relay = Arc::new(DerpServer::new([9; 32], Arc::new(AllowAll), DerpConfig::default()));
        let (gw_secret, stranger_secret) = ([11u8; 32], [33u8; 32]);
        // The gateway's directory does not know the stranger
        let gateway_view = Arc::new(Fixed(vec![(public_key(&gw_secret), GATEWAY)]));
        let stranger_view = Arc::new(Fixed(vec![(public_key(&gw_secret), GATEWAY), (public_key(&stranger_secret), STRANGER)]));
        let gateway = Tailnet::spawn(gw_secret, GATEWAY, relay.attach_local(public_key(&gw_secret), scope()), gateway_view);
        let stranger = Tailnet::spawn(stranger_secret, STRANGER, relay.attach_local(public_key(&stranger_secret), scope()), stranger_view);
        let _incoming = gateway.listen(443).await.unwrap();
        let attempt = tokio::time::timeout(Duration::from_secs(2), stranger.connect(SocketAddrV4::new(GATEWAY, 443))).await;
        assert!(attempt.is_err() || attempt.unwrap().is_err(), "a stranger must not reach the gateway");
    }

    #[tokio::test]
    async fn a_device_cannot_send_with_the_address_of_another_device() {
        let relay = Arc::new(DerpServer::new([9; 32], Arc::new(AllowAll), DerpConfig::default()));
        let (gw_secret, dev_secret) = ([11u8; 32], [22u8; 32]);
        // The gateway knows the device at DEVICE; the device's own stack claims STRANGER
        let gateway_view = Arc::new(Fixed(vec![(public_key(&gw_secret), GATEWAY), (public_key(&dev_secret), DEVICE)]));
        let liar_view = Arc::new(Fixed(vec![(public_key(&gw_secret), GATEWAY), (public_key(&dev_secret), STRANGER)]));
        let gateway = Tailnet::spawn(gw_secret, GATEWAY, relay.attach_local(public_key(&gw_secret), scope()), gateway_view);
        let liar = Tailnet::spawn(dev_secret, STRANGER, relay.attach_local(public_key(&dev_secret), scope()), liar_view);
        let _incoming = gateway.listen(443).await.unwrap();
        let attempt = tokio::time::timeout(Duration::from_secs(2), liar.connect(SocketAddrV4::new(GATEWAY, 443))).await;
        assert!(attempt.is_err() || attempt.unwrap().is_err(), "a spoofed source address must be dropped");
    }
}
