//! The client address of a request, for display (ADR-0032: the approval page
//! shows where a device sign-in came from).
//!
//! Behind a reverse proxy (Caddy) the TCP peer is the proxy, so
//! `X-Forwarded-For` is read, but only when the peer is a configured trusted
//! proxy (`COORD_TRUSTED_PROXIES`, comma-separated CIDRs or addresses).
//! Anyone else could write any value into that header.

use std::net::IpAddr;

use axum::http::HeaderMap;
use ipnetwork::IpNetwork;

#[derive(Debug, Clone, Default)]
pub struct TrustedProxies {
    nets: Vec<IpNetwork>,
}

impl TrustedProxies {
    /// Parse a comma-separated list of CIDRs or single addresses. Empty
    /// input = no trusted proxy (the peer address is always used).
    pub fn parse(list: &str) -> Result<Self, String> {
        let mut nets = Vec::new();
        for item in list.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            let net = match item.parse::<IpNetwork>() {
                Ok(n) => n,
                Err(_) => item
                    .parse::<IpAddr>()
                    .map(IpNetwork::from)
                    .map_err(|_| format!("invalid trusted proxy {item:?} (use a CIDR such as 10.0.0.0/8)"))?,
            };
            nets.push(net);
        }
        Ok(Self { nets })
    }

    pub fn is_empty(&self) -> bool {
        self.nets.is_empty()
    }

    pub fn contains(&self, ip: IpAddr) -> bool {
        let ip = canonical(ip);
        self.nets.iter().any(|n| n.contains(ip))
    }

    /// The client address: the peer itself, unless the peer is a trusted
    /// proxy. Then `X-Forwarded-For` is walked from the right (the entry the
    /// nearest proxy appended) past further trusted proxies; the first
    /// untrusted address is the client. An unusable header falls back to the
    /// peer.
    pub fn client_ip(&self, peer: Option<IpAddr>, headers: &HeaderMap) -> Option<IpAddr> {
        let peer = canonical(peer?);
        if !self.contains(peer) {
            return Some(peer);
        }
        let mut hops: Vec<IpAddr> = Vec::new();
        for value in headers.get_all("x-forwarded-for") {
            let Ok(text) = value.to_str() else { return Some(peer) };
            for part in text.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                match parse_hop(part) {
                    Some(ip) => hops.push(canonical(ip)),
                    None => return Some(peer),
                }
            }
        }
        let mut client = peer;
        for hop in hops.into_iter().rev() {
            client = hop;
            if !self.contains(hop) {
                break;
            }
        }
        Some(client)
    }
}

/// An X-Forwarded-For entry: an address, maybe with a port or in brackets.
fn parse_hop(s: &str) -> Option<IpAddr> {
    if let Ok(ip) = s.parse() {
        return Some(ip);
    }
    if let Ok(sa) = s.parse::<std::net::SocketAddr>() {
        return Some(sa.ip());
    }
    s.strip_prefix('[')?.strip_suffix(']')?.parse().ok()
}

/// IPv4-mapped IPv6 (`::ffff:a.b.c.d`, what a dual-stack listener reports)
/// as plain IPv4.
fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        v4 => v4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn xff(v: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", v.parse().unwrap());
        h
    }

    fn ip(s: &str) -> Option<IpAddr> {
        Some(s.parse().unwrap())
    }

    #[test]
    fn without_trusted_proxies_the_header_is_ignored() {
        let t = TrustedProxies::parse("").unwrap();
        assert!(t.is_empty());
        assert_eq!(t.client_ip(ip("10.0.0.5"), &xff("1.2.3.4")), ip("10.0.0.5"));
        assert_eq!(t.client_ip(None, &xff("1.2.3.4")), None);
    }

    #[test]
    fn an_untrusted_peer_cannot_spoof_the_header() {
        let t = TrustedProxies::parse("10.250.0.0/16").unwrap();
        assert_eq!(t.client_ip(ip("198.51.100.9"), &xff("1.2.3.4")), ip("198.51.100.9"));
    }

    #[test]
    fn a_trusted_peer_gives_the_rightmost_untrusted_hop() {
        let t = TrustedProxies::parse("10.250.0.0/16, 172.16.0.1").unwrap();
        // The client wrote a fake first entry; Caddy appended the real address
        assert_eq!(t.client_ip(ip("10.250.250.2"), &xff("6.6.6.6, 203.0.113.7")), ip("203.0.113.7"));
        assert_eq!(t.client_ip(ip("10.250.250.2"), &xff("203.0.113.7, 172.16.0.1")), ip("203.0.113.7"));
        assert_eq!(t.client_ip(ip("::ffff:10.250.250.2"), &xff("[2001:db8::1]")), ip("2001:db8::1"));
        assert_eq!(t.client_ip(ip("10.250.250.2"), &xff("203.0.113.7:4431")), ip("203.0.113.7"));
        // No header, or garbage: the peer
        assert_eq!(t.client_ip(ip("10.250.250.2"), &HeaderMap::new()), ip("10.250.250.2"));
        assert_eq!(t.client_ip(ip("10.250.250.2"), &xff("not-an-ip")), ip("10.250.250.2"));
    }

    #[test]
    fn bad_lists_are_rejected() {
        assert!(TrustedProxies::parse("10.0.0.0/8,nonsense").is_err());
        assert!(TrustedProxies::parse(" 10.0.0.0/8 , ::1 ").is_ok());
    }
}
