//! CIDR helpers for subnet routes / exit nodes and node tag validation.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// Max routes a single node may advertise; extra entries are dropped.
pub const MAX_ADVERTISED_ROUTES: usize = 256;
/// Max tags carried by a pre-auth key (and therefore a node).
pub const MAX_TAGS: usize = 8;
/// Max length of an opaque owner string.
pub const MAX_OWNER_LEN: usize = 128;

/// A parsed, normalised prefix (host bits cleared).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cidr {
    pub addr: IpAddr,
    pub len: u8,
}

impl Cidr {
    pub fn parse(s: &str) -> Option<Self> {
        let (ip_str, len_str) = s.trim().split_once('/')?;
        let addr: IpAddr = ip_str.parse().ok()?;
        if len_str.is_empty() || !len_str.bytes().all(|b| b.is_ascii_digit()) || len_str.len() > 3 {
            return None;
        }
        let len: u8 = len_str.parse().ok()?;
        let max = if addr.is_ipv4() { 32 } else { 128 };
        if len > max {
            return None;
        }
        Some(Self { addr: mask(addr, len), len })
    }

    pub fn is_exit(&self) -> bool {
        self.len == 0
    }

    /// True if `inner` lies entirely within `self`.
    pub fn contains(&self, inner: &Cidr) -> bool {
        if self.addr.is_ipv4() != inner.addr.is_ipv4() || inner.len < self.len {
            return false;
        }
        mask(inner.addr, self.len) == self.addr
    }
}

impl std::fmt::Display for Cidr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", self.addr, self.len)
    }
}

fn mask(addr: IpAddr, len: u8) -> IpAddr {
    match addr {
        IpAddr::V4(v4) => {
            let bits = u32::from(v4);
            let m = if len == 0 { 0 } else { u32::MAX << (32 - u32::from(len)) };
            IpAddr::V4(Ipv4Addr::from(bits & m))
        }
        IpAddr::V6(v6) => {
            let bits = u128::from(v6);
            let m = if len == 0 { 0 } else { u128::MAX << (128 - u32::from(len)) };
            IpAddr::V6(Ipv6Addr::from(bits & m))
        }
    }
}

/// Normalise a single CIDR string (clears host bits). `None` if unparseable.
pub fn normalize_cidr(s: &str) -> Option<String> {
    Cidr::parse(s).map(|c| c.to_string())
}

/// Normalise, dedupe and sort a list of CIDRs, silently dropping invalid entries
/// and capping at [`MAX_ADVERTISED_ROUTES`]. Used for client-supplied RoutableIPs.
pub fn normalize_routes_lossy<S: AsRef<str>>(routes: &[S]) -> Vec<String> {
    let mut out: Vec<String> = routes
        .iter()
        .filter_map(|r| normalize_cidr(r.as_ref()))
        .collect();
    out.sort();
    out.dedup();
    out.truncate(MAX_ADVERTISED_ROUTES);
    out
}

/// Normalise, dedupe and sort; returns the first invalid entry as an error.
pub fn normalize_routes_strict<S: AsRef<str>>(routes: &[S]) -> Result<Vec<String>, String> {
    let mut out = Vec::with_capacity(routes.len());
    for r in routes {
        match normalize_cidr(r.as_ref()) {
            Some(c) => out.push(c),
            None => return Err(r.as_ref().to_string()),
        }
    }
    out.sort();
    out.dedup();
    Ok(out)
}

pub fn is_exit_route(s: &str) -> bool {
    Cidr::parse(s).is_some_and(|c| c.is_exit())
}

/// Routes actually served: approved routes that are still advertised.
pub fn effective_routes(advertised: &[String], approved: &[String]) -> Vec<String> {
    approved
        .iter()
        .filter(|r| advertised.contains(r))
        .cloned()
        .collect()
}

/// `^tag:[a-z0-9-]{1,63}$`
pub fn is_valid_tag(s: &str) -> bool {
    let Some(name) = s.strip_prefix("tag:") else {
        return false;
    };
    !name.is_empty()
        && name.len() <= 63
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalises_host_bits() {
        assert_eq!(normalize_cidr("10.1.2.3/16").as_deref(), Some("10.1.0.0/16"));
        assert_eq!(normalize_cidr("0.0.0.0/0").as_deref(), Some("0.0.0.0/0"));
        assert_eq!(normalize_cidr("fd00::1/64").as_deref(), Some("fd00::/64"));
        assert_eq!(normalize_cidr("::/0").as_deref(), Some("::/0"));
        assert!(normalize_cidr("10.0.0.0/33").is_none());
        assert!(normalize_cidr("10.0.0.0").is_none());
        assert!(normalize_cidr("10.0.0.0/+8").is_none());
        assert!(normalize_cidr("nope/8").is_none());
    }

    #[test]
    fn containment() {
        let outer = Cidr::parse("10.0.0.0/8").unwrap();
        assert!(outer.contains(&Cidr::parse("10.1.0.0/16").unwrap()));
        assert!(outer.contains(&Cidr::parse("10.0.0.0/8").unwrap()));
        assert!(!outer.contains(&Cidr::parse("0.0.0.0/0").unwrap()));
        assert!(!outer.contains(&Cidr::parse("192.168.0.0/16").unwrap()));
        assert!(!outer.contains(&Cidr::parse("fd00::/8").unwrap()));
    }

    #[test]
    fn tags() {
        assert!(is_valid_tag("tag:federation-relay"));
        assert!(!is_valid_tag("tag:"));
        assert!(!is_valid_tag("tag:Upper"));
        assert!(!is_valid_tag("relay"));
        assert!(!is_valid_tag(&format!("tag:{}", "a".repeat(64))));
    }

    #[test]
    fn lossy_dedupes_and_drops_invalid() {
        let r = normalize_routes_lossy(&["10.0.0.1/24", "bogus", "10.0.0.0/24", "::/0"]);
        assert_eq!(r, vec!["10.0.0.0/24".to_string(), "::/0".to_string()]);
    }
}
