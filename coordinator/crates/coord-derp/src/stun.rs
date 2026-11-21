//! Minimal STUN server (RFC 5389 binding requests only).
//! Tailscale clients use it to learn their public address and find direct paths.
//! The response is about the request size, so the server cannot amplify traffic.

use std::net::{IpAddr, SocketAddr};
use tokio::net::UdpSocket;

const MAGIC_COOKIE: [u8; 4] = [0x21, 0x12, 0xa4, 0x42];
const HEADER_LEN: usize = 20;
const BINDING_REQUEST: [u8; 2] = [0x00, 0x01];
const BINDING_SUCCESS: [u8; 2] = [0x01, 0x01];
const ATTR_XOR_MAPPED_ADDRESS: [u8; 2] = [0x00, 0x20];
/// Largest request accepted. A binding request with SOFTWARE and FINGERPRINT is far smaller.
const MAX_REQUEST_LEN: usize = 512;

/// Build the binding-success response for `request` received from `src`, or
/// `None` when the datagram is not a well-formed STUN binding request.
pub fn binding_response(request: &[u8], src: SocketAddr) -> Option<Vec<u8>> {
    if request.len() < HEADER_LEN || request.len() > MAX_REQUEST_LEN {
        return None;
    }
    if request[0..2] != BINDING_REQUEST || request[4..8] != MAGIC_COOKIE {
        return None;
    }
    let attr_len = usize::from(u16::from_be_bytes([request[2], request[3]]));
    if attr_len % 4 != 0 || attr_len != request.len() - HEADER_LEN {
        return None;
    }
    let txid = &request[8..20];

    let port = src.port() ^ u16::from_be_bytes([MAGIC_COOKIE[0], MAGIC_COOKIE[1]]);
    let mut attr = Vec::with_capacity(24);
    attr.extend_from_slice(&ATTR_XOR_MAPPED_ADDRESS);
    match src.ip().to_canonical() {
        IpAddr::V4(ip) => {
            attr.extend_from_slice(&8u16.to_be_bytes());
            attr.extend_from_slice(&[0x00, 0x01]);
            attr.extend_from_slice(&port.to_be_bytes());
            attr.extend(ip.octets().iter().zip(MAGIC_COOKIE).map(|(a, b)| a ^ b));
        }
        IpAddr::V6(ip) => {
            attr.extend_from_slice(&20u16.to_be_bytes());
            attr.extend_from_slice(&[0x00, 0x02]);
            attr.extend_from_slice(&port.to_be_bytes());
            let mask = MAGIC_COOKIE.iter().chain(txid.iter());
            attr.extend(ip.octets().iter().zip(mask).map(|(a, b)| a ^ b));
        }
    }

    let mut out = Vec::with_capacity(HEADER_LEN + attr.len());
    out.extend_from_slice(&BINDING_SUCCESS);
    out.extend_from_slice(&(attr.len() as u16).to_be_bytes());
    out.extend_from_slice(&MAGIC_COOKIE);
    out.extend_from_slice(txid);
    out.extend_from_slice(&attr);
    Some(out)
}

/// Answer binding requests on `socket` until it fails.
pub async fn serve(socket: UdpSocket) -> std::io::Result<()> {
    let mut buf = [0u8; MAX_REQUEST_LEN + 1];
    loop {
        let (n, src) = socket.recv_from(&mut buf).await?;
        if let Some(resp) = binding_response(&buf[..n], src) {
            // Best effort: a failed send to one client must not stop the server.
            let _ = socket.send_to(&resp, src).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(txid: [u8; 12]) -> Vec<u8> {
        let mut r = vec![0x00, 0x01, 0x00, 0x00];
        r.extend_from_slice(&MAGIC_COOKIE);
        r.extend_from_slice(&txid);
        r
    }

    #[test]
    fn ipv4_response_decodes_to_the_source_address() {
        let txid = [9u8; 12];
        let src: SocketAddr = "203.0.113.7:54321".parse().unwrap();
        let resp = binding_response(&request(txid), src).unwrap();
        assert_eq!(&resp[0..2], &BINDING_SUCCESS);
        assert_eq!(u16::from_be_bytes([resp[2], resp[3]]), 12);
        assert_eq!(&resp[4..8], &MAGIC_COOKIE);
        assert_eq!(&resp[8..20], &txid);
        assert_eq!(&resp[20..24], &[0x00, 0x20, 0x00, 0x08]);
        assert_eq!(resp[25], 0x01);
        let port = u16::from_be_bytes([resp[26], resp[27]]) ^ 0x2112;
        let ip: Vec<u8> = resp[28..32].iter().zip(MAGIC_COOKIE).map(|(a, b)| a ^ b).collect();
        assert_eq!(port, 54321);
        assert_eq!(ip, [203, 0, 113, 7]);
    }

    #[test]
    fn ipv6_response_decodes_and_mapped_ipv4_is_reported_as_ipv4() {
        let txid = [3u8; 12];
        let src: SocketAddr = "[2001:db8::1234]:4000".parse().unwrap();
        let resp = binding_response(&request(txid), src).unwrap();
        assert_eq!(&resp[20..24], &[0x00, 0x20, 0x00, 0x14]);
        assert_eq!(resp[25], 0x02);
        let mask: Vec<u8> = MAGIC_COOKIE.iter().chain(txid.iter()).copied().collect();
        let ip: Vec<u8> = resp[28..44].iter().zip(mask).map(|(a, b)| a ^ b).collect();
        assert_eq!(ip, "2001:db8::1234".parse::<std::net::Ipv6Addr>().unwrap().octets());

        let mapped: SocketAddr = "[::ffff:198.51.100.2]:9".parse().unwrap();
        let resp = binding_response(&request(txid), mapped).unwrap();
        assert_eq!(resp[25], 0x01, "IPv4-mapped source is answered as IPv4");
    }

    #[test]
    fn accepts_requests_with_attributes() {
        let mut r = request([1u8; 12]);
        r.extend_from_slice(&[0x80, 0x22, 0x00, 0x04, b't', b'a', b'i', b'l']);
        r[3] = 8;
        assert!(binding_response(&r, "192.0.2.1:1".parse().unwrap()).is_some());
    }

    #[test]
    fn rejects_everything_that_is_not_a_binding_request() {
        let src: SocketAddr = "192.0.2.1:1".parse().unwrap();
        assert!(binding_response(&[], src).is_none());
        assert!(binding_response(&[0u8; 19], src).is_none());
        let mut bad_cookie = request([0u8; 12]);
        bad_cookie[4] = 0;
        assert!(binding_response(&bad_cookie, src).is_none());
        let mut not_binding = request([0u8; 12]);
        not_binding[1] = 0x02;
        assert!(binding_response(&not_binding, src).is_none());
        let mut bad_len = request([0u8; 12]);
        bad_len[3] = 4;
        assert!(binding_response(&bad_len, src).is_none());
        assert!(binding_response(&vec![0u8; MAX_REQUEST_LEN + 1], src).is_none());
    }

    #[tokio::test]
    async fn serves_over_udp() {
        let server = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let addr = server.local_addr().unwrap();
        tokio::spawn(serve(server));
        let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        client.send_to(&request([5u8; 12]), addr).await.unwrap();
        let mut buf = [0u8; 64];
        let (n, _) = tokio::time::timeout(std::time::Duration::from_secs(2), client.recv_from(&mut buf))
            .await
            .unwrap()
            .unwrap();
        let port = u16::from_be_bytes([buf[26], buf[27]]) ^ 0x2112;
        assert_eq!(n, 32);
        assert_eq!(port, client.local_addr().unwrap().port());
    }
}
