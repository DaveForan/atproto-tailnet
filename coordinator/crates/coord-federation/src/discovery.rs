//! Peer discovery for cross-instance federation (ADR-0019 section 3).
//!
//! Ported from `src/federation/discovery.ts` (148 lines).
//! Fetches and validates a remote collective's federation descriptor.

use std::net::IpAddr;
use std::time::Duration;

use tracing::warn;

use coord_core::CoordError;

use crate::protocol::{Capability, FederationDescriptor};

// ── Constants ──────────────────────────────────────────────────────────────────

/// HTTP request timeout for discovery fetches.
pub const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(10);

// ── Types ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct PeerInfo {
    pub did: String,
    pub broker_url: String,
    pub name: String,
    pub capabilities: Vec<Capability>,
    pub federation_policy: String,
}

// ── Functions ──────────────────────────────────────────────────────────────────

/// Discover a remote collective by its `slug@host` address.
///
/// Fetches `https://{host}/.well-known/collective-federation?collective={slug}`,
/// validates the response, and checks the federation policy is not closed.
pub async fn discover_peer(
    client: &reqwest::Client,
    peer_address: &str,
) -> Result<PeerInfo, CoordError> {
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

    if is_private_or_loopback_host(host) {
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

    if !is_allowed_broker_url(&descriptor.broker_url) {
        return Err(CoordError::Protocol(format!(
            "Peer broker URL {} is not allowed",
            descriptor.broker_url
        )));
    }

    Ok(PeerInfo {
        did: descriptor.collective_did,
        broker_url: descriptor.broker_url,
        name: slug.to_string(),
        capabilities: descriptor.capabilities,
        federation_policy: format!("{:?}", descriptor.federation_policy).to_lowercase(),
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

/// Check whether a broker URL is safe (not pointing at private/loopback addresses).
///
/// Rejects:
/// - Non-HTTPS schemes (except localhost for dev)
/// - Hosts that resolve to private or loopback IP ranges
pub fn is_allowed_broker_url(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };

    let scheme = parsed.scheme();
    let Some(host_str) = parsed.host_str() else {
        return false;
    };

    // Non-HTTPS is only allowed for localhost (dev convenience).
    if scheme != "https" && !is_localhost(host_str) {
        return false;
    }

    !is_private_or_loopback_host(host_str)
}

/// Check if a hostname string refers to localhost.
fn is_localhost(host: &str) -> bool {
    host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"
}

/// SSRF protection: reject private, loopback, and link-local addresses.
fn is_private_or_loopback_host(host: &str) -> bool {
    if is_localhost(host) {
        return true;
    }

    // Try to parse as an IP address directly.
    if let Ok(ip) = host.parse::<IpAddr>() {
        return is_private_ip(&ip);
    }

    // Strip brackets for IPv6 literals like [::1].
    let stripped = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = stripped.parse::<IpAddr>() {
        return is_private_ip(&ip);
    }

    // For hostnames that look like dotted quads (e.g., 10.0.0.1), parse them.
    if let Ok(ip) = host.parse::<std::net::Ipv4Addr>() {
        return is_private_ip(&IpAddr::V4(ip));
    }

    false
}

/// Check if an IP address is private, loopback, or link-local.
fn is_private_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                // 169.254.x.x is covered by is_link_local
                || v4.octets()[0] == 0 // 0.0.0.0/8
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                // Rust stable doesn't have is_unique_local() yet, check manually
                || (v6.segments()[0] & 0xfe00) == 0xfc00 // fc00::/7
                || (v6.segments()[0] == 0xfe80) // fe80::/10 link-local
        }
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_allowed_broker_url_rejects_private_ips() {
        assert!(!is_allowed_broker_url("https://127.0.0.1/api"));
        assert!(!is_allowed_broker_url("https://10.0.0.1/api"));
        assert!(!is_allowed_broker_url("https://192.168.1.1/api"));
        assert!(!is_allowed_broker_url("https://172.16.0.1/api"));
        assert!(!is_allowed_broker_url("https://localhost/api"));
        assert!(!is_allowed_broker_url("https://[::1]/api"));
    }

    #[test]
    fn is_allowed_broker_url_accepts_public() {
        assert!(is_allowed_broker_url("https://example.com/api"));
        assert!(is_allowed_broker_url("https://broker.federation.net/api"));
    }

    #[test]
    fn is_allowed_broker_url_rejects_non_https() {
        assert!(!is_allowed_broker_url("http://example.com/api"));
        assert!(!is_allowed_broker_url("ftp://example.com/api"));
    }

    #[test]
    fn is_allowed_broker_url_rejects_invalid() {
        assert!(!is_allowed_broker_url(""));
        assert!(!is_allowed_broker_url("not-a-url"));
    }

    #[test]
    fn is_private_or_loopback_host_coverage() {
        assert!(is_private_or_loopback_host("localhost"));
        assert!(is_private_or_loopback_host("127.0.0.1"));
        assert!(is_private_or_loopback_host("::1"));
        assert!(is_private_or_loopback_host("[::1]"));
        assert!(is_private_or_loopback_host("10.0.0.1"));
        assert!(is_private_or_loopback_host("172.16.0.1"));
        assert!(is_private_or_loopback_host("192.168.0.1"));
        assert!(!is_private_or_loopback_host("8.8.8.8"));
        assert!(!is_private_or_loopback_host("example.com"));
    }

    #[test]
    fn urlencoding_encode_basic() {
        assert_eq!(urlencoding_encode("hello"), "hello");
        assert_eq!(urlencoding_encode("my collective"), "my%20collective");
        assert_eq!(urlencoding_encode("a+b"), "a%2Bb");
    }
}
