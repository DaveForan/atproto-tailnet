//! Peer discovery for cross-instance federation (ADR-0019 section 3).
//! Fetches and validates a remote collective's federation descriptor.

use std::net::IpAddr;
use std::time::Duration;

use tracing::warn;

use coord_core::CoordError;

use crate::protocol::{Capability, FederationDescriptor};


/// HTTP request timeout for discovery fetches.
pub const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(10);


#[derive(Debug, Clone)]
pub struct DiscoveredPeer {
    pub did: String,
    pub broker_url: String,
    pub name: String,
    pub capabilities: Vec<Capability>,
    pub federation_policy: String,
}


/// Discovers a remote collective by its `slug@host` address.
/// Fetches `https://{host}/.well-known/collective-federation?collective={slug}`.
/// It validates the response and rejects a closed federation policy.
pub async fn discover_peer(
    client: &reqwest::Client,
    peer_address: &str,
) -> Result<DiscoveredPeer, CoordError> {
    if peer_address.starts_with("did:") {
        return Err(CoordError::Protocol(
            "Direct DID lookup not yet supported; use slug@host format".to_string(),
        ));
    }

    let at_idx = peer_address
        .find('@')
        .ok_or_else(|| CoordError::Protocol("Peer address must be slug@host or a DID".to_string()))?;

    let slug = &peer_address[..at_idx];
    let host = &peer_address[at_idx + 1..];

    if slug.is_empty() || host.is_empty() {
        return Err(CoordError::Protocol(
            "Invalid peer address format".to_string(),
        ));
    }

    if is_private_or_loopback_host(host).await {
        return Err(CoordError::Protocol(format!(
            "Host {host} is not allowed (private/loopback)"
        )));
    }

    let url = format!(
        "https://{host}/.well-known/collective-federation?collective={}",
        urlencoding_encode(slug)
    );

    let res = client
        .get(&url)
        .header("Accept", "application/json")
        .timeout(DISCOVERY_TIMEOUT)
        .send()
        .await
        .map_err(|e| {
            warn!(host = %host, slug = %slug, err = %e, "peer discovery fetch failed");
            CoordError::Protocol(format!("Discovery failed: {e}"))
        })?;

    if !res.status().is_success() {
        return Err(CoordError::Protocol(format!(
            "Discovery failed: HTTP {} from {host}",
            res.status()
        )));
    }

    let descriptor: FederationDescriptor = res.json().await.map_err(|e| {
        CoordError::Protocol(format!("Failed to parse discovery document: {e}"))
    })?;

    if descriptor.collective_did.is_empty() || descriptor.broker_url.is_empty() {
        return Err(CoordError::Protocol(
            "Incomplete discovery document (missing DID or broker URL)".to_string(),
        ));
    }

    if descriptor.federation_policy == crate::protocol::FederationPolicy::Closed {
        return Err(CoordError::Protocol(format!(
            "Collective {slug}@{host} has a closed federation policy"
        )));
    }

    if !is_allowed_broker_url(&descriptor.broker_url).await {
        return Err(CoordError::Protocol(format!(
            "Peer broker URL {} is not allowed",
            descriptor.broker_url
        )));
    }

    Ok(DiscoveredPeer {
        did: descriptor.collective_did,
        broker_url: descriptor.broker_url,
        name: slug.to_string(),
        capabilities: descriptor.capabilities,
        federation_policy: descriptor.federation_policy.as_str().to_string(),
    })
}

/// Minimal percent-encoding for the `collective` query parameter.
fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push_str(&format!("%{b:02X}"));
            }
        }
    }
    out
}

/// Returns `true` only for an HTTPS URL whose host is not private or loopback.
pub async fn is_allowed_broker_url(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };

    let scheme = parsed.scheme();
    let Some(host_str) = parsed.host_str() else {
        return false;
    };

    if scheme != "https" && !is_localhost(host_str) {
        return false;
    }

    !is_private_or_loopback_host(host_str).await
}

fn is_localhost(host: &str) -> bool {
    host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"
}

/// SSRF guard: returns `true` for private, loopback, or link-local hosts, and on DNS failure.
/// It resolves hostnames so a public-looking name cannot point at a private IP.
async fn is_private_or_loopback_host(host: &str) -> bool {
    if is_localhost(host) {
        return true;
    }

    if let Ok(ip) = host.parse::<IpAddr>() {
        return is_private_ip(&ip);
    }

    // IPv6 literals can arrive bracketed, e.g. `[::1]`.
    let stripped = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = stripped.parse::<IpAddr>() {
        return is_private_ip(&ip);
    }

    match tokio::net::lookup_host((host, 443)).await {
        Ok(addrs) => {
            for addr in addrs {
                if is_private_ip(&addr.ip()) {
                    warn!(host = %host, ip = %addr.ip(), "DNS resolved to private IP");
                    return true;
                }
            }
            false
        }
        Err(_) => {
            warn!(host = %host, "DNS resolution failed — rejecting");
            true
        }
    }
}

/// Returns `true` for any address that is not public unicast.
/// This covers CGNAT, ULA, NAT64, benchmarking ranges, and IPv4-mapped or -compatible forms.
fn is_private_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || o[0] == 0 // 0.0.0.0/8
                || (o[0] == 100 && (o[1] & 0xc0) == 64) // 100.64.0.0/10 CGNAT
                || (o[0] == 192 && o[1] == 0 && o[2] == 0) // 192.0.0.0/24
                || (o[0] == 198 && (o[1] & 0xfe) == 18) // 198.18.0.0/15
                || o[0] >= 240 // 240.0.0.0/4 reserved
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_private_ip(&IpAddr::V4(v4));
            }
            let seg = v6.segments();
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (seg[0] & 0xfe00) == 0xfc00 // fc00::/7 ULA
                || (seg[0] & 0xffc0) == 0xfe80 // fe80::/10 link-local
                || (seg[0] == 0x64 && seg[1] == 0xff9b) // 64:ff9b::/96 NAT64
                // ::/96 IPv4-compatible (deprecated) is never a real peer.
                || seg[..6].iter().all(|&s| s == 0)
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn is_allowed_broker_url_rejects_private_ips() {
        assert!(!is_allowed_broker_url("https://127.0.0.1/api").await);
        assert!(!is_allowed_broker_url("https://10.0.0.1/api").await);
        assert!(!is_allowed_broker_url("https://192.168.1.1/api").await);
        assert!(!is_allowed_broker_url("https://172.16.0.1/api").await);
        assert!(!is_allowed_broker_url("https://localhost/api").await);
        assert!(!is_allowed_broker_url("https://[::1]/api").await);
    }

    #[tokio::test]
    async fn is_allowed_broker_url_accepts_public() {
        assert!(is_allowed_broker_url("https://example.com/api").await);
    }

    #[tokio::test]
    async fn is_allowed_broker_url_rejects_non_https() {
        assert!(!is_allowed_broker_url("http://example.com/api").await);
        assert!(!is_allowed_broker_url("ftp://example.com/api").await);
    }

    #[test]
    fn is_allowed_broker_url_rejects_invalid() {
        // These inputs fail URL parsing before any DNS lookup.
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            assert!(!is_allowed_broker_url("").await);
            assert!(!is_allowed_broker_url("not-a-url").await);
        });
    }

    #[tokio::test]
    async fn is_private_or_loopback_host_coverage() {
        assert!(is_private_or_loopback_host("localhost").await);
        assert!(is_private_or_loopback_host("127.0.0.1").await);
        assert!(is_private_or_loopback_host("::1").await);
        assert!(is_private_or_loopback_host("[::1]").await);
        assert!(is_private_or_loopback_host("10.0.0.1").await);
        assert!(is_private_or_loopback_host("172.16.0.1").await);
        assert!(is_private_or_loopback_host("192.168.0.1").await);
        assert!(!is_private_or_loopback_host("8.8.8.8").await);
    }

    #[tokio::test]
    async fn rejects_cgnat_unspecified_ula_and_mapped() {
        for host in [
            "100.64.0.1",
            "100.127.255.254",
            "0.0.0.0",
            "::",
            "fd00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "[::ffff:7f00:1]",
            "224.0.0.1",
        ] {
            assert!(is_private_or_loopback_host(host).await, "{host} must be rejected");
        }
        assert!(!is_private_or_loopback_host("100.128.0.1").await);
        assert!(!is_private_or_loopback_host("2606:4700::1111").await);
        assert!(!is_private_or_loopback_host("::ffff:8.8.8.8").await);
    }

    #[test]
    fn urlencoding_encode_basic() {
        assert_eq!(urlencoding_encode("hello"), "hello");
        assert_eq!(urlencoding_encode("my collective"), "my%20collective");
        assert_eq!(urlencoding_encode("a+b"), "a%2Bb");
    }
}
