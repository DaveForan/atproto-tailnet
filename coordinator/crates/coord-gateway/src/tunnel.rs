//! The gateway's WireGuard side in one tailnet (ADR-0029).
//! Packets use the in-process relay (ADR-0027), so the gateway needs no public UDP port.
//! Security: a decrypted packet must carry its sender's tailnet address, so no device can spoof another.

use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use boringtun::noise::errors::WireGuardError;
use boringtun::noise::{Tunn, TunnResult};
use boringtun::x25519::{PublicKey, StaticSecret};
use bytes::Bytes;
use coord_derp::LocalClient;
use tokio::sync::{mpsc, Notify};
use tracing::debug;

use crate::netstack::NetStack;

/// `TS💬` disco packet prefix. The gateway ignores disco, so devices keep using the relay.
const DISCO_MAGIC: &[u8; 6] = b"TS\xf0\x9f\x92\xac";
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

/// The gateway's directory of its tailnet's devices. The coordinator answers from its store.
#[async_trait::async_trait]
pub trait Devices: Send + Sync + 'static {
    /// The tailnet address for this node key, if the key is a device of this tailnet.
    async fn addr_of(&self, node_key: &[u8; 32]) -> Option<Ipv4Addr>;
    /// The node key of the device with this tailnet address.
    async fn key_of(&self, addr: Ipv4Addr) -> Option<[u8; 32]>;
    /// Fires when a device joins, leaves, or changes key or address.
    /// The gateway then drops cached answers, so the change applies at once.
    /// `None` keeps answers for [`DIRECTORY_TTL`].
    fn changes(&self) -> Option<Arc<Notify>> {
        None
    }
}

struct Session {
    tunn: Tunn,
    addr: Ipv4Addr,
    last_used: Instant,
}

struct Cached<T> {
    value: Option<T>,
    at: Instant,
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
}

impl Tailnet {
    /// Joins a tailnet with node key `secret` and tailnet address `addr`.
    /// `relay` must be attached with the public half of `secret`.
    pub fn spawn(secret: [u8; 32], addr: Ipv4Addr, relay: LocalClient, devices: Arc<dyn Devices>) -> NetStack {
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
        };
        tokio::spawn(tailnet.run(out_rx));
        stack
    }

    async fn run(mut self, mut out: mpsc::Receiver<Vec<u8>>) {
        let mut tick = tokio::time::interval(TIMER_TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut buf = vec![0u8; WG_BUFFER];
        let changes = self.devices.changes();
        loop {
            let changed = async {
                match &changes {
                    Some(n) => n.notified().await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                _ = changed => self.forget_directory(),
                received = self.relay.recv() => match received {
                    Some((from, data)) => self.handle_device_packet(from, &data, &mut buf).await,
                    None => return, // another client took our key: this instance is over
                },
                packet = out.recv() => match packet {
                    Some(packet) => self.send_to_device(&packet, &mut buf).await,
                    None => return, // the stack stopped
                },
                _ = tick.tick() => self.timers(&mut buf),
            }
        }
    }

    /// Drops all cached directory answers.
    /// Sessions stay, because each packet re-checks its sender with the directory.
    fn forget_directory(&mut self) {
        self.by_key.clear();
        self.by_addr.clear();
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

    /// Handles a WireGuard packet that a device sent through the relay.
    async fn handle_device_packet(&mut self, from: [u8; 32], data: &[u8], buf: &mut [u8]) {
        if data.starts_with(DISCO_MAGIC) {
            return;
        }
        let Some(addr) = self.addr_of(&from).await else {
            return; // not a device of this tailnet
        };
        let stack = self.stack.clone();
        let Some(session) = session(&mut self.sessions, &self.secret, &mut self.next_index, from, addr) else { return };
        let mut input: &[u8] = data;
        loop {
            match session.tunn.decapsulate(None, input, buf) {
                TunnResult::WriteToNetwork(reply) => {
                    self.relay.send(from, Bytes::copy_from_slice(reply));
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
        let Some(session) = session(&mut self.sessions, &self.secret, &mut self.next_index, key, dst) else { return };
        session.last_used = Instant::now();
        match session.tunn.encapsulate(packet, buf) {
            // The encrypted packet, or a handshake while the packet waits in the session.
            TunnResult::WriteToNetwork(data) => self.relay.send(key, Bytes::copy_from_slice(data)),
            TunnResult::Err(e) => debug!(error = ?e, "could not encrypt a packet"),
            _ => {}
        }
    }

    /// WireGuard timers: handshake retries, key rotation, keep-alives.
    fn timers(&mut self, buf: &mut [u8]) {
        let mut gone = Vec::new();
        for (key, session) in &mut self.sessions {
            if session.last_used.elapsed() > IDLE_SESSION {
                gone.push(*key);
                continue;
            }
            match session.tunn.update_timers(buf) {
                TunnResult::WriteToNetwork(data) => self.relay.send(*key, Bytes::copy_from_slice(data)),
                TunnResult::Err(WireGuardError::ConnectionExpired) => gone.push(*key),
                _ => {}
            }
        }
        for key in gone {
            self.sessions.remove(&key);
        }
    }
}

/// Returns the session with a device, and creates it on the first packet.
fn session<'a>(
    sessions: &'a mut HashMap<[u8; 32], Session>,
    secret: &StaticSecret,
    next_index: &mut u32,
    key: [u8; 32],
    addr: Ipv4Addr,
) -> Option<&'a mut Session> {
    if !sessions.contains_key(&key) {
        if sessions.len() >= MAX_SESSIONS {
            return None;
        }
        *next_index = (*next_index + 1) & 0x00ff_ffff;
        let tunn = Tunn::new(secret.clone(), PublicKey::from(key), None, None, *next_index, None);
        sessions.insert(key, Session { tunn, addr, last_used: Instant::now() });
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
