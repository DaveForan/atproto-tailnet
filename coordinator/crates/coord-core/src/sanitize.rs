//! Bounds and normalisation for client-supplied fields before storage or peer fan-out.

/// Max entries kept from a client's Endpoints list.
pub const MAX_ENDPOINTS: usize = 32;
/// Max length of one endpoint string (`[v6]:port` is at most 47 chars).
pub const MAX_ENDPOINT_LEN: usize = 64;
/// Max length of a stored OS string.
pub const MAX_OS_LEN: usize = 64;
/// Max length of a DNS label.
pub const MAX_DNS_LABEL_LEN: usize = 63;

/// Reduce a client hostname to one DNS label of lowercase `a-z0-9-`, at most 63 bytes.
/// Other characters fold to one '-'. `None` if nothing usable remains.
/// # Security
/// Dots never survive, so the result cannot spoof another FQDN.
pub fn dns_label(raw: &str) -> Option<String> {
    let mut out = String::with_capacity(raw.len().min(MAX_DNS_LABEL_LEN));
    let mut last_dash = true; // suppress leading '-'
    for c in raw.chars() {
        if out.len() >= MAX_DNS_LABEL_LEN {
            break;
        }
        let c = c.to_ascii_lowercase();
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() { None } else { Some(out) }
}

/// The DNS label to use for a node: its sanitised hostname, or `node-<id>`.
pub fn node_dns_label(raw: &str, node_id: i64) -> String {
    dns_label(raw).unwrap_or_else(|| format!("node-{node_id}"))
}

/// Keep at most [`MAX_ENDPOINTS`] short endpoints that parse as `ip:port`.
pub fn endpoints(raw: &[String]) -> Vec<String> {
    raw.iter()
        .filter(|e| e.len() <= MAX_ENDPOINT_LEN && e.parse::<std::net::SocketAddr>().is_ok())
        .take(MAX_ENDPOINTS)
        .cloned()
        .collect()
}

/// A disco key must be exactly `discokey:` + 64 hex chars.
pub fn disco_key(raw: &str) -> Option<String> {
    let hex = raw.strip_prefix("discokey:")?;
    (hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit())).then(|| raw.to_ascii_lowercase())
}

/// Keep printable ASCII only and truncate to [`MAX_OS_LEN`].
pub fn os(raw: Option<&str>) -> String {
    let s: String = raw
        .unwrap_or("")
        .chars()
        .filter(|c| c.is_ascii_graphic() || *c == ' ')
        .take(MAX_OS_LEN)
        .collect();
    let s = s.trim();
    if s.is_empty() { "unknown".into() } else { s.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dns_label_rules() {
        assert_eq!(dns_label("My Laptop").as_deref(), Some("my-laptop"));
        assert_eq!(dns_label("victim.other.mesh.local").as_deref(), Some("victim-other-mesh-local"));
        assert_eq!(dns_label("--a__b--").as_deref(), Some("a-b"));
        assert_eq!(dns_label("ünïcode").as_deref(), Some("n-code"));
        assert_eq!(dns_label("...").as_deref(), None);
        assert_eq!(dns_label(&"x".repeat(500)).unwrap().len(), 63);
        let long = format!("{}-{}", "a".repeat(62), "b");
        assert!(!dns_label(&long).unwrap().ends_with('-'));
        assert_eq!(node_dns_label("", 7), "node-7");
    }

    #[test]
    fn endpoint_and_disco_rules() {
        let mut eps: Vec<String> = (0..100).map(|i| format!("1.2.3.{}:41641", i % 250)).collect();
        eps.insert(0, "not-an-endpoint".into());
        eps.insert(0, "x".repeat(10_000));
        let out = endpoints(&eps);
        assert_eq!(out.len(), MAX_ENDPOINTS);
        assert_eq!(out[0], "1.2.3.0:41641");
        assert_eq!(endpoints(&["[fd00::1]:41641".into()]).len(), 1);
        let k = format!("discokey:{}", "ab".repeat(32));
        assert_eq!(disco_key(&k).as_deref(), Some(k.as_str()));
        assert!(disco_key(&format!("{k}00")).is_none());
        assert!(disco_key(&"ab".repeat(32)).is_none());
        assert_eq!(os(Some(&"l".repeat(1000))).len(), MAX_OS_LEN);
        assert_eq!(os(None), "unknown");
    }
}
