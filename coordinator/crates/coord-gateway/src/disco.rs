//! Disco messages of Tailscale clients (ADR-0029 phase 2): ping, pong and call-me-maybe in a NaCl box.
//! Client wire compatibility only. No Tailscale code.

use std::net::{IpAddr, Ipv6Addr, SocketAddr};

use crypto_box::aead::generic_array::GenericArray;
use crypto_box::aead::AeadInPlace;
use crypto_box::{PublicKey, SalsaBox, SecretKey};

/// `TS💬`, the first bytes of each disco packet.
pub const MAGIC: &[u8; 6] = b"TS\xf0\x9f\x92\xac";
const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 24;
const TAG_LEN: usize = 16;
/// Magic, sender key and nonce. The box follows.
const HEADER_LEN: usize = MAGIC.len() + KEY_LEN + NONCE_LEN;
/// The box of the shortest message: a type and a version.
const MIN_PACKET: usize = HEADER_LEN + TAG_LEN + 2;
const TX_LEN: usize = 12;
/// An address in a message: 16 bytes of IPv6 (IPv4 is mapped) and a big-endian port.
const ENDPOINT_LEN: usize = 18;

const TYPE_PING: u8 = 1;
const TYPE_PONG: u8 = 2;
const TYPE_CALL_ME_MAYBE: u8 = 3;
const VERSION: u8 = 0;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Message {
    /// `node_key` is the sender's claim. The disco key that opens the box is the proof of the sender.
    Ping { tx: [u8; TX_LEN], node_key: Option<[u8; 32]> },
    /// `src` is the address the ping came from, as the sender of the pong saw it.
    Pong { tx: [u8; TX_LEN], src: SocketAddr },
    CallMeMaybe { endpoints: Vec<SocketAddr> },
}

fn put_endpoint(out: &mut Vec<u8>, addr: SocketAddr) {
    let ip = match addr.ip() {
        IpAddr::V4(v4) => v4.to_ipv6_mapped(),
        IpAddr::V6(v6) => v6,
    };
    out.extend_from_slice(&ip.octets());
    out.extend_from_slice(&addr.port().to_be_bytes());
}

fn endpoint(bytes: &[u8]) -> Option<SocketAddr> {
    let ip: [u8; 16] = bytes.get(..16)?.try_into().ok()?;
    let port: [u8; 2] = bytes.get(16..ENDPOINT_LEN)?.try_into().ok()?;
    Some(SocketAddr::new(IpAddr::V6(Ipv6Addr::from(ip)).to_canonical(), u16::from_be_bytes(port)))
}

impl Message {
    /// The message as it goes into the box.
    pub fn encode(&self) -> Vec<u8> {
        match self {
            Message::Ping { tx, node_key } => {
                let mut out = vec![TYPE_PING, VERSION];
                out.extend_from_slice(tx);
                if let Some(key) = node_key {
                    out.extend_from_slice(key);
                }
                out
            }
            Message::Pong { tx, src } => {
                let mut out = vec![TYPE_PONG, VERSION];
                out.extend_from_slice(tx);
                put_endpoint(&mut out, *src);
                out
            }
            Message::CallMeMaybe { endpoints } => {
                let mut out = vec![TYPE_CALL_ME_MAYBE, VERSION];
                for e in endpoints {
                    put_endpoint(&mut out, *e);
                }
                out
            }
        }
    }

    /// Reads a message from an opened box. Bytes after the known fields are padding or newer fields.
    pub fn decode(plain: &[u8]) -> Option<Message> {
        let (kind, body) = (*plain.first()?, plain.get(2..)?);
        match kind {
            TYPE_PING => {
                let tx = body.get(..TX_LEN)?.try_into().ok()?;
                let node_key = body.get(TX_LEN..TX_LEN + 32).and_then(|k| k.try_into().ok());
                Some(Message::Ping { tx, node_key })
            }
            TYPE_PONG => {
                let tx = body.get(..TX_LEN)?.try_into().ok()?;
                let src = endpoint(body.get(TX_LEN..)?)?;
                Some(Message::Pong { tx, src })
            }
            TYPE_CALL_ME_MAYBE => Some(Message::CallMeMaybe { endpoints: body.chunks_exact(ENDPOINT_LEN).filter_map(endpoint).collect() }),
            _ => None,
        }
    }
}

/// The disco key of the sender of `packet`, when `packet` has the form of a disco packet.
pub fn sender(packet: &[u8]) -> Option<[u8; 32]> {
    if packet.len() < MIN_PACKET || !packet.starts_with(MAGIC) {
        return None;
    }
    packet[MAGIC.len()..MAGIC.len() + KEY_LEN].try_into().ok()
}

/// The public half of a disco key.
pub fn public_key(secret: &[u8; 32]) -> [u8; 32] {
    SecretKey::from_bytes(*secret).public_key().to_bytes()
}

/// The box between our disco key and the disco key of one peer.
pub struct Channel {
    own_public: [u8; 32],
    shared: SalsaBox,
}

impl Channel {
    pub fn new(own_secret: &[u8; 32], peer_public: &[u8; 32]) -> Self {
        let secret = SecretKey::from_bytes(*own_secret);
        Self { own_public: secret.public_key().to_bytes(), shared: SalsaBox::new(&PublicKey::from_bytes(*peer_public), &secret) }
    }

    /// A disco packet with `message` for the peer. The nonce must be new for each packet.
    pub fn seal(&self, message: &Message, nonce: [u8; NONCE_LEN]) -> Vec<u8> {
        let mut body = message.encode();
        let tag = self.shared.encrypt_in_place_detached(GenericArray::from_slice(&nonce), b"", &mut body).expect("a disco message is short");
        let mut packet = Vec::with_capacity(HEADER_LEN + TAG_LEN + body.len());
        packet.extend_from_slice(MAGIC);
        packet.extend_from_slice(&self.own_public);
        packet.extend_from_slice(&nonce);
        // NaCl order: the tag comes before the ciphertext.
        packet.extend_from_slice(&tag);
        packet.extend_from_slice(&body);
        packet
    }

    /// Opens a disco packet. `None` when the peer of this channel did not seal it for us.
    pub fn open(&self, packet: &[u8]) -> Option<Message> {
        sender(packet)?;
        let nonce = GenericArray::from_slice(&packet[MAGIC.len() + KEY_LEN..HEADER_LEN]);
        let (tag, sealed) = packet[HEADER_LEN..].split_at(TAG_LEN);
        let mut body = sealed.to_vec();
        self.shared.decrypt_in_place_detached(nonce, b"", &mut body, GenericArray::from_slice(tag)).ok()?;
        Message::decode(&body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    const TX: [u8; 12] = [0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab];

    #[test]
    fn messages_have_the_wire_form_of_the_client() {
        let ping = Message::Ping { tx: TX, node_key: Some([0x11; 32]) };
        assert_eq!(ping.encode(), hex(&format!("0100a0a1a2a3a4a5a6a7a8a9aaab{}", "11".repeat(32))));
        assert_eq!(Message::Ping { tx: TX, node_key: None }.encode(), hex("0100a0a1a2a3a4a5a6a7a8a9aaab"));

        let pong = Message::Pong { tx: TX, src: "203.0.113.7:41641".parse().unwrap() };
        assert_eq!(pong.encode(), hex("0200a0a1a2a3a4a5a6a7a8a9aaab00000000000000000000ffffcb007107a2a9"));
        let pong6 = Message::Pong { tx: TX, src: "[2001:db8::1]:443".parse().unwrap() };
        assert_eq!(pong6.encode(), hex("0200a0a1a2a3a4a5a6a7a8a9aaab20010db800000000000000000000000101bb"));

        let call = Message::CallMeMaybe { endpoints: vec!["192.0.2.1:1".parse().unwrap(), "[2001:db8::2]:65535".parse().unwrap()] };
        assert_eq!(call.encode(), hex("030000000000000000000000ffffc0000201000120010db8000000000000000000000002ffff"));

        for m in [ping, pong, pong6, call] {
            assert_eq!(Message::decode(&m.encode()), Some(m));
        }
    }

    #[test]
    fn padding_and_short_or_unknown_messages() {
        // A padded ping, as clients send to measure the path MTU.
        let mut padded = Message::Ping { tx: TX, node_key: Some([0x11; 32]) }.encode();
        padded.extend_from_slice(&[0; 300]);
        assert_eq!(Message::decode(&padded), Some(Message::Ping { tx: TX, node_key: Some([0x11; 32]) }));
        // A node key that is not complete is padding.
        assert_eq!(Message::decode(&hex("0100a0a1a2a3a4a5a6a7a8a9aaab1111")), Some(Message::Ping { tx: TX, node_key: None }));
        // A later version of a known type stays readable.
        assert_eq!(Message::decode(&hex("0107a0a1a2a3a4a5a6a7a8a9aaab")), Some(Message::Ping { tx: TX, node_key: None }));

        assert_eq!(Message::decode(&[]), None);
        assert_eq!(Message::decode(&[TYPE_PING]), None);
        assert_eq!(Message::decode(&hex("0100a0a1a2")), None, "a short transaction id");
        assert_eq!(Message::decode(&hex("0200a0a1a2a3a4a5a6a7a8a9aaab00000000")), None, "a pong without its address");
        assert_eq!(Message::decode(&hex("0900a0a1a2a3a4a5a6a7a8a9aaab")), None, "an unknown type");
        assert_eq!(Message::decode(&hex("0300")), Some(Message::CallMeMaybe { endpoints: vec![] }));
    }

    // Keys, nonce and packet come from an independent NaCl implementation (TweetNaCl `box`).
    const ALICE_SECRET: [u8; 32] = [0x01; 32];
    const BOB_SECRET: [u8; 32] = [0x02; 32];
    const ALICE_PUBLIC: &str = "a4e09292b651c278b9772c569f5fa9bb13d906b46ab68c9df9dc2b4409f8a209";
    const BOB_PUBLIC: &str = "ce8d3ad1ccb633ec7b70c17814a5c76ecd029685050d344745ba05870e587d59";
    const NONCE: [u8; 24] = [0x03; 24];
    const SEALED_PING: &str = "5453f09f92aca4e09292b651c278b9772c569f5fa9bb13d906b46ab68c9df9dc2b4409f8a20903030303030303030303030303030303030303030303030355f83a317063ca23fd8652b6993ed9efe22bdfae89b59e0b82a78eded001d1eadb4bb1a479051bf5474aa25763746b22038bd5a513f9b0be4a24540e0dce";

    #[test]
    fn the_box_agrees_with_an_independent_nacl_implementation() {
        assert_eq!(public_key(&ALICE_SECRET).to_vec(), hex(ALICE_PUBLIC));
        assert_eq!(public_key(&BOB_SECRET).to_vec(), hex(BOB_PUBLIC));
        let bob_public: [u8; 32] = hex(BOB_PUBLIC).try_into().unwrap();
        let alice_public: [u8; 32] = hex(ALICE_PUBLIC).try_into().unwrap();
        let ping = Message::Ping { tx: TX, node_key: Some([0x11; 32]) };

        let packet = Channel::new(&ALICE_SECRET, &bob_public).seal(&ping, NONCE);
        assert_eq!(packet, hex(SEALED_PING));
        assert_eq!(sender(&packet), Some(alice_public));
        assert_eq!(Channel::new(&BOB_SECRET, &alice_public).open(&packet), Some(ping));
    }

    #[test]
    fn a_box_from_another_key_or_a_changed_box_does_not_open() {
        let (alice, bob, eve) = ([0x01; 32], [0x02; 32], [0x05; 32]);
        let ping = Message::Ping { tx: TX, node_key: None };
        let bob_side = Channel::new(&bob, &public_key(&alice));
        let good = Channel::new(&alice, &public_key(&bob)).seal(&ping, NONCE);
        assert_eq!(bob_side.open(&good), Some(ping.clone()));

        // Eve seals with her own key but names Alice as the sender.
        let mut forged = Channel::new(&eve, &public_key(&bob)).seal(&ping, NONCE);
        forged[6..38].copy_from_slice(&public_key(&alice));
        assert_eq!(bob_side.open(&forged), None);

        for at in [38, HEADER_LEN, good.len() - 1] {
            let mut changed = good.clone();
            changed[at] ^= 1;
            assert_eq!(bob_side.open(&changed), None, "byte {at}");
        }
        assert_eq!(bob_side.open(&good[..MIN_PACKET - 1]), None);
        assert_eq!(sender(&good[..MIN_PACKET - 1]), None);
        let mut other_magic = good.clone();
        other_magic[0] = b'X';
        assert_eq!(sender(&other_magic), None);
    }
}
