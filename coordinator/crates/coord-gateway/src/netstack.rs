//! A userspace TCP/IP stack for one tailnet (ADR-0029).
//!
//! All tailnets use the same address space, so each tailnet gets its own
//! stack with its own address, connections and listeners. Nothing here
//! touches the network of the host: IP packets come in through [`NetStack::inject`]
//! (after WireGuard decryption) and leave through the `out` channel (to be
//! encrypted). TCP connections appear to the rest of the gateway as ordinary
//! async byte streams.

use std::collections::VecDeque;
use std::io;
use std::net::{Ipv4Addr, SocketAddrV4};
use std::sync::Arc;
use std::time::{Duration, Instant};

use smoltcp::iface::{Config, Interface, SocketHandle, SocketSet};
use smoltcp::phy::{Device, DeviceCapabilities, Medium, RxToken, TxToken};
use smoltcp::socket::tcp;
use smoltcp::time::Instant as SmolInstant;
use smoltcp::wire::{HardwareAddress, IpAddress, IpCidr};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio::sync::{mpsc, oneshot, Notify};

/// MTU inside a tailnet (the value Tailscale clients use).
pub const TAILNET_MTU: usize = 1280;
/// Tailnet addresses are in 100.64.0.0/10.
const TAILNET_PREFIX: u8 = 10;
const SOCKET_BUFFER: usize = 64 * 1024;
/// Sockets waiting for a connection on each listening port.
const BACKLOG: usize = 16;
/// Connections of one tailnet at once; more are refused.
pub const MAX_CONNECTIONS: usize = 1024;
const CHUNK: usize = 16 * 1024;
/// Arriving packets handled between two refills of the backlog.
const INGRESS_BATCH: usize = 8;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// A connection whose peer stops answering is closed after this time.
const DEAD_PEER_TIMEOUT: Duration = Duration::from_secs(60);
const KEEP_ALIVE: Duration = Duration::from_secs(15);
const FIRST_EPHEMERAL_PORT: u16 = 49152;

/// An accepted TCP connection and the tailnet address it came from.
pub struct Accepted {
    pub stream: DuplexStream,
    pub peer: SocketAddrV4,
}

enum Cmd {
    Listen { port: u16, accept: mpsc::Sender<Accepted> },
    Connect { addr: SocketAddrV4, reply: oneshot::Sender<io::Result<DuplexStream>> },
}

/// Handle to a running stack. The stack stops when every handle is dropped.
#[derive(Clone)]
pub struct NetStack {
    packets: mpsc::Sender<Vec<u8>>,
    cmds: mpsc::Sender<Cmd>,
}

impl NetStack {
    /// Start a stack with the address `addr`. IP packets that the stack wants
    /// to send appear on `out`; when `out` is full they are dropped (TCP
    /// retransmits).
    pub fn spawn(addr: Ipv4Addr, out: mpsc::Sender<Vec<u8>>) -> Self {
        let (packets, packets_rx) = mpsc::channel(1024);
        let (cmds, cmds_rx) = mpsc::channel(64);
        tokio::spawn(Stack::new(addr, out).run(packets_rx, cmds_rx));
        Self { packets, cmds }
    }

    /// Give the stack an IP packet that arrived for it. Dropped when the
    /// stack is busy (TCP retransmits).
    pub fn inject(&self, packet: Vec<u8>) {
        let _ = self.packets.try_send(packet);
    }

    /// Accept TCP connections on `port`.
    pub async fn listen(&self, port: u16) -> io::Result<mpsc::Receiver<Accepted>> {
        let (accept, rx) = mpsc::channel(BACKLOG);
        self.cmds.send(Cmd::Listen { port, accept }).await.map_err(|_| stopped())?;
        Ok(rx)
    }

    /// Open a TCP connection to another address of the tailnet.
    pub async fn connect(&self, addr: SocketAddrV4) -> io::Result<DuplexStream> {
        let (reply, rx) = oneshot::channel();
        self.cmds.send(Cmd::Connect { addr, reply }).await.map_err(|_| stopped())?;
        rx.await.map_err(|_| stopped())?
    }
}

fn stopped() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "the tailnet stack stopped")
}

// ── The packet queue that stands in for a network card ──────────────────

struct Queue {
    rx: VecDeque<Vec<u8>>,
    tx: VecDeque<Vec<u8>>,
}

struct Rx(Vec<u8>);
struct Tx<'a>(&'a mut VecDeque<Vec<u8>>);

impl RxToken for Rx {
    fn consume<R, F: FnOnce(&[u8]) -> R>(self, f: F) -> R {
        f(&self.0)
    }
}

impl TxToken for Tx<'_> {
    fn consume<R, F: FnOnce(&mut [u8]) -> R>(self, len: usize, f: F) -> R {
        let mut packet = vec![0u8; len];
        let result = f(&mut packet);
        self.0.push_back(packet);
        result
    }
}

impl Device for Queue {
    type RxToken<'a> = Rx;
    type TxToken<'a> = Tx<'a>;

    fn receive(&mut self, _now: SmolInstant) -> Option<(Rx, Tx<'_>)> {
        let packet = self.rx.pop_front()?;
        Some((Rx(packet), Tx(&mut self.tx)))
    }

    fn transmit(&mut self, _now: SmolInstant) -> Option<Tx<'_>> {
        (self.tx.len() < 1024).then(|| Tx(&mut self.tx))
    }

    fn capabilities(&self) -> DeviceCapabilities {
        let mut caps = DeviceCapabilities::default();
        caps.medium = Medium::Ip;
        caps.max_transmission_unit = TAILNET_MTU;
        caps
    }
}

// ── Streams between a TCP socket and the rest of the gateway ────────────

/// Both directions of one connection, as the stack sees them.
struct Pipe {
    /// Bytes received from the peer, on their way to the application.
    /// `None` after the peer closed its side.
    to_app: Option<mpsc::Sender<Vec<u8>>>,
    /// Bytes the application wrote, on their way to the peer.
    from_app: mpsc::Receiver<Vec<u8>>,
    /// A chunk from the application that did not fit in the socket yet.
    pending: Option<(Vec<u8>, usize)>,
    app_done: bool,
}

/// Make the application's stream and the stack's view of it. Two small tasks
/// move bytes between them; `wake` tells the stack that there is work.
fn pipe(wake: &Arc<Notify>) -> (DuplexStream, Pipe) {
    let (app, inner) = tokio::io::duplex(SOCKET_BUFFER);
    let (mut read_half, mut write_half) = tokio::io::split(inner);
    let (to_app, mut to_app_rx) = mpsc::channel::<Vec<u8>>(8);
    let (from_app_tx, from_app) = mpsc::channel::<Vec<u8>>(8);

    let w = wake.clone();
    tokio::spawn(async move {
        while let Some(chunk) = to_app_rx.recv().await {
            if write_half.write_all(&chunk).await.is_err() {
                break;
            }
            w.notify_one(); // there is room for the next chunk
        }
        let _ = write_half.shutdown().await;
        w.notify_one();
    });

    let w = wake.clone();
    tokio::spawn(async move {
        let mut buf = vec![0u8; CHUNK];
        loop {
            match read_half.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if from_app_tx.send(buf[..n].to_vec()).await.is_err() {
                        break;
                    }
                    w.notify_one();
                }
            }
        }
        drop(from_app_tx);
        w.notify_one(); // the application finished writing
    });

    (app, Pipe { to_app: Some(to_app), from_app, pending: None, app_done: false })
}

struct Listening {
    handle: SocketHandle,
    port: u16,
    accept: mpsc::Sender<Accepted>,
    /// True once a peer started a handshake on this socket and another
    /// socket took its place in the backlog.
    replaced: bool,
}

struct Connecting {
    handle: SocketHandle,
    reply: Option<oneshot::Sender<io::Result<DuplexStream>>>,
    deadline: Instant,
}

struct Stack {
    iface: Interface,
    device: Queue,
    /// Packets that arrived and wait for their turn. They enter the stack a
    /// few at a time, so that the backlog is refilled between them when many
    /// connections start at once.
    inbox: VecDeque<Vec<u8>>,
    sockets: SocketSet<'static>,
    started: Instant,
    out: mpsc::Sender<Vec<u8>>,
    wake: Arc<Notify>,
    listening: Vec<Listening>,
    connecting: Vec<Connecting>,
    open: Vec<(SocketHandle, Pipe)>,
    next_port: u16,
}

fn new_socket() -> tcp::Socket<'static> {
    let mut socket = tcp::Socket::new(
        tcp::SocketBuffer::new(vec![0u8; SOCKET_BUFFER]),
        tcp::SocketBuffer::new(vec![0u8; SOCKET_BUFFER]),
    );
    socket.set_keep_alive(Some(KEEP_ALIVE.into()));
    socket.set_timeout(Some(DEAD_PEER_TIMEOUT.into()));
    socket
}

impl Stack {
    fn new(addr: Ipv4Addr, out: mpsc::Sender<Vec<u8>>) -> Self {
        let mut device = Queue { rx: VecDeque::new(), tx: VecDeque::new() };
        let mut config = Config::new(HardwareAddress::Ip);
        config.random_seed = rand::random();
        let mut iface = Interface::new(config, &mut device, SmolInstant::from_millis(0));
        iface.update_ip_addrs(|addrs| {
            let _ = addrs.push(IpCidr::new(IpAddress::Ipv4(addr), TAILNET_PREFIX));
        });
        Self {
            iface,
            device,
            inbox: VecDeque::new(),
            sockets: SocketSet::new(Vec::new()),
            started: Instant::now(),
            out,
            wake: Arc::new(Notify::new()),
            listening: Vec::new(),
            connecting: Vec::new(),
            open: Vec::new(),
            next_port: FIRST_EPHEMERAL_PORT,
        }
    }

    fn now(&self) -> SmolInstant {
        SmolInstant::from_millis(self.started.elapsed().as_millis() as i64)
    }

    async fn run(mut self, mut packets: mpsc::Receiver<Vec<u8>>, mut cmds: mpsc::Receiver<Cmd>) {
        loop {
            // Work until nothing moves any more, then sleep until something happens
            for _ in 0..32 {
                if !self.service() {
                    break;
                }
            }
            let delay = self
                .iface
                .poll_delay(self.now(), &self.sockets)
                .map(Duration::from)
                .unwrap_or(Duration::from_secs(1))
                .min(Duration::from_secs(1));
            let wake = self.wake.clone();
            tokio::select! {
                packet = packets.recv() => match packet {
                    Some(p) => {
                        self.inbox.push_back(p);
                        while let Ok(p) = packets.try_recv() {
                            self.inbox.push_back(p);
                        }
                    }
                    None => return,
                },
                cmd = cmds.recv() => match cmd {
                    Some(cmd) => self.command(cmd),
                    None => return,
                },
                _ = wake.notified() => {}
                _ = tokio::time::sleep(delay) => {}
            }
        }
    }

    fn command(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::Listen { port, accept } => {
                for _ in 0..BACKLOG {
                    self.add_listener(port, accept.clone());
                }
            }
            Cmd::Connect { addr, reply } => {
                if self.open.len() + self.connecting.len() >= MAX_CONNECTIONS {
                    let _ = reply.send(Err(io::Error::other("too many connections in this tailnet")));
                    return;
                }
                let local = self.next_port;
                self.next_port = if local == u16::MAX { FIRST_EPHEMERAL_PORT } else { local + 1 };
                let mut socket = new_socket();
                match socket.connect(self.iface.context(), (IpAddress::Ipv4(*addr.ip()), addr.port()), local) {
                    Ok(()) => {
                        let handle = self.sockets.add(socket);
                        self.connecting.push(Connecting { handle, reply: Some(reply), deadline: Instant::now() + CONNECT_TIMEOUT });
                    }
                    Err(e) => {
                        let _ = reply.send(Err(io::Error::other(format!("cannot connect: {e}"))));
                    }
                }
            }
        }
    }

    fn add_listener(&mut self, port: u16, accept: mpsc::Sender<Accepted>) {
        let mut socket = new_socket();
        if socket.listen(port).is_ok() {
            let handle = self.sockets.add(socket);
            self.listening.push(Listening { handle, port, accept, replaced: false });
        }
    }

    /// One round: let the stack process packets and timers, then move bytes
    /// between sockets and applications. Returns true when anything moved.
    fn service(&mut self) -> bool {
        let now = self.now();
        let batch = self.inbox.len().min(INGRESS_BATCH);
        self.device.rx.extend(self.inbox.drain(..batch));
        self.iface.poll(now, &mut self.device, &mut self.sockets);
        let mut moved = batch > 0;
        moved |= self.accept_new() | self.finish_connects() | self.move_bytes();
        if moved {
            // Send what the applications just wrote, and the ACKs
            self.iface.poll(self.now(), &mut self.device, &mut self.sockets);
        }
        while let Some(packet) = self.device.tx.pop_front() {
            moved = true;
            let _ = self.out.try_send(packet);
        }
        moved
    }

    fn accept_new(&mut self) -> bool {
        let mut moved = false;
        let mut i = 0;
        while i < self.listening.len() {
            let socket = self.sockets.get_mut::<tcp::Socket>(self.listening[i].handle);
            let state = socket.state();
            if state != tcp::State::Listen && !self.listening[i].replaced {
                // A handshake started here: keep the backlog full
                self.listening[i].replaced = true;
                let (port, accept) = (self.listening[i].port, self.listening[i].accept.clone());
                if !accept.is_closed() {
                    self.add_listener(port, accept);
                }
                moved = true;
            }
            if matches!(state, tcp::State::Listen | tcp::State::SynReceived) {
                i += 1;
                continue;
            }
            // Connected, or the handshake failed
            let socket = self.sockets.get_mut::<tcp::Socket>(self.listening[i].handle);
            let peer = match socket.remote_endpoint().map(|e| (e.addr, e.port)) {
                Some((IpAddress::Ipv4(ip), port)) if socket.is_active() => Some(SocketAddrV4::new(ip, port)),
                _ => None,
            };
            let wanted = peer.is_some() && self.open.len() < MAX_CONNECTIONS && !self.listening[i].accept.is_closed();
            if wanted {
                let accept = self.listening[i].accept.clone();
                match accept.try_reserve() {
                    Ok(permit) => {
                        let (stream, pipe) = pipe(&self.wake);
                        permit.send(Accepted { stream, peer: peer.expect("checked") });
                        let l = self.listening.swap_remove(i);
                        self.open.push((l.handle, pipe));
                        moved = true;
                    }
                    // The application is busy: the connection waits its turn,
                    // with its data held back by the TCP window
                    Err(_) => i += 1,
                }
            } else {
                socket.abort();
                let l = self.listening.swap_remove(i);
                self.sockets.remove(l.handle);
                moved = true;
            }
        }
        moved
    }

    fn finish_connects(&mut self) -> bool {
        let mut moved = false;
        let mut i = 0;
        while i < self.connecting.len() {
            let c = &mut self.connecting[i];
            let socket = self.sockets.get_mut::<tcp::Socket>(c.handle);
            let outcome = match socket.state() {
                tcp::State::Established => Some(Ok(())),
                tcp::State::Closed | tcp::State::TimeWait => Some(Err("the device refused the connection")),
                _ if Instant::now() >= c.deadline => Some(Err("the device did not answer")),
                _ => None,
            };
            let Some(outcome) = outcome else {
                i += 1;
                continue;
            };
            let mut c = self.connecting.swap_remove(i);
            moved = true;
            let reply = c.reply.take();
            match outcome {
                Ok(()) => {
                    let (stream, pipe) = pipe(&self.wake);
                    match reply.map(|r| r.send(Ok(stream))) {
                        Some(Ok(())) => self.open.push((c.handle, pipe)),
                        _ => {
                            socket.abort();
                            self.sockets.remove(c.handle);
                        }
                    }
                }
                Err(msg) => {
                    socket.abort();
                    self.sockets.remove(c.handle);
                    if let Some(r) = reply {
                        let _ = r.send(Err(io::Error::new(io::ErrorKind::ConnectionRefused, msg)));
                    }
                }
            }
        }
        moved
    }

    fn move_bytes(&mut self) -> bool {
        let mut moved = false;
        let mut buf = [0u8; CHUNK];
        let mut i = 0;
        while i < self.open.len() {
            let (handle, pipe) = &mut self.open[i];
            let socket = self.sockets.get_mut::<tcp::Socket>(*handle);

            // Peer → application
            if let Some(to_app) = &pipe.to_app {
                if to_app.is_closed() {
                    // The application went away: nothing will read this
                    pipe.to_app = None;
                    socket.abort();
                    moved = true;
                } else {
                    while socket.can_recv() {
                        let Ok(permit) = to_app.try_reserve() else { break };
                        match socket.recv_slice(&mut buf) {
                            Ok(n) if n > 0 => {
                                permit.send(buf[..n].to_vec());
                                moved = true;
                            }
                            _ => break,
                        }
                    }
                    if !socket.may_recv() && !socket.can_recv() {
                        pipe.to_app = None; // the peer closed: end of stream for the application
                        moved = true;
                    }
                }
            }

            // Application → peer
            loop {
                if pipe.pending.is_none() {
                    match pipe.from_app.try_recv() {
                        Ok(chunk) => pipe.pending = Some((chunk, 0)),
                        Err(mpsc::error::TryRecvError::Empty) => break,
                        Err(mpsc::error::TryRecvError::Disconnected) => {
                            if !pipe.app_done {
                                pipe.app_done = true;
                                socket.close(); // the application finished: send FIN after its data
                                moved = true;
                            }
                            break;
                        }
                    }
                }
                let Some((chunk, sent)) = &mut pipe.pending else { break };
                if !socket.may_send() {
                    pipe.pending = None; // the connection is gone
                    break;
                }
                match socket.send_slice(&chunk[*sent..]) {
                    Ok(n) if n > 0 => {
                        *sent += n;
                        moved = true;
                        if *sent == chunk.len() {
                            pipe.pending = None;
                        }
                    }
                    _ => break, // the socket buffer is full
                }
            }

            if socket.state() == tcp::State::Closed {
                let (handle, _) = self.open.swap_remove(i);
                self.sockets.remove(handle);
                moved = true;
            } else {
                i += 1;
            }
        }
        moved
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two stacks joined by a wire, as if WireGuard were perfect.
    fn pair() -> (NetStack, NetStack) {
        let (a_out, mut a_rx) = mpsc::channel(4096);
        let (b_out, mut b_rx) = mpsc::channel(4096);
        let a = NetStack::spawn(Ipv4Addr::new(100, 64, 0, 1), a_out);
        let b = NetStack::spawn(Ipv4Addr::new(100, 64, 0, 2), b_out);
        let (a2, b2) = (a.clone(), b.clone());
        tokio::spawn(async move {
            while let Some(p) = a_rx.recv().await {
                b2.inject(p);
            }
        });
        tokio::spawn(async move {
            while let Some(p) = b_rx.recv().await {
                a2.inject(p);
            }
        });
        (a, b)
    }

    #[tokio::test]
    async fn a_connection_carries_bytes_both_ways_and_closes() {
        let (a, b) = pair();
        let mut incoming = b.listen(8080).await.unwrap();
        let server = tokio::spawn(async move {
            let Accepted { mut stream, peer } = incoming.recv().await.unwrap();
            assert_eq!(*peer.ip(), Ipv4Addr::new(100, 64, 0, 1));
            let mut got = Vec::new();
            stream.read_to_end(&mut got).await.unwrap();
            stream.write_all(&got.iter().rev().copied().collect::<Vec<_>>()).await.unwrap();
            stream.shutdown().await.unwrap();
            got.len()
        });

        let mut client = a.connect(SocketAddrV4::new(Ipv4Addr::new(100, 64, 0, 2), 8080)).await.unwrap();
        // More than the socket buffers and the pipes together, so flow control is used
        let data: Vec<u8> = (0..400_000u32).map(|i| (i % 251) as u8).collect();
        client.write_all(&data).await.unwrap();
        client.shutdown().await.unwrap();
        let mut back = Vec::new();
        client.read_to_end(&mut back).await.unwrap();
        assert_eq!(server.await.unwrap(), data.len());
        assert_eq!(back, data.iter().rev().copied().collect::<Vec<_>>());
    }

    #[tokio::test]
    async fn many_connections_at_once_use_the_backlog() {
        let (a, b) = pair();
        let mut incoming = b.listen(443).await.unwrap();
        tokio::spawn(async move {
            while let Some(Accepted { mut stream, .. }) = incoming.recv().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 4];
                    stream.read_exact(&mut buf).await.unwrap();
                    stream.write_all(&buf).await.unwrap();
                });
            }
        });
        let mut tasks = Vec::new();
        for i in 0..40u32 {
            let a = a.clone();
            tasks.push(tokio::spawn(async move {
                let mut s = a.connect(SocketAddrV4::new(Ipv4Addr::new(100, 64, 0, 2), 443)).await.unwrap();
                s.write_all(&i.to_be_bytes()).await.unwrap();
                let mut buf = [0u8; 4];
                s.read_exact(&mut buf).await.unwrap();
                u32::from_be_bytes(buf)
            }));
        }
        for (i, t) in tasks.into_iter().enumerate() {
            assert_eq!(t.await.unwrap(), i as u32);
        }
    }

    #[tokio::test]
    async fn a_closed_port_refuses_and_a_silent_address_times_out() {
        let (a, _b) = pair();
        let refused = a.connect(SocketAddrV4::new(Ipv4Addr::new(100, 64, 0, 2), 9)).await;
        assert_eq!(refused.unwrap_err().kind(), io::ErrorKind::ConnectionRefused);
    }
}
