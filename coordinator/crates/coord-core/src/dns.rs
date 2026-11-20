//! Per-tenant DNS (ADR-0028): device names and service names that resolve
//! only inside the tailnet.
//!
//! The coordinator sends each device a split-DNS route for the base domain
//! (always with upstream resolvers, so names without a record still resolve
//! publicly), the records that device may see, and a search domain for short
//! device names.

use serde::{Deserialize, Serialize};
use std::net::IpAddr;

pub const MAX_DNS_RECORDS: usize = 2000;
pub const MAX_DNS_UPSTREAMS: usize = 4;
pub const MAX_RECORD_NODES: usize = 256;

/// Ports that the gateway serves on its tailnet address.
pub const GATEWAY_PORTS: [u16; 2] = [80, 443];

/// One service name. It resolves to the address of `node`, for the devices of
/// `owner` and the devices listed in `nodes`. With neither, every device of
/// the tenant sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DnsRecord {
    /// One DNS label; the full name is `<name>.<base_domain>`.
    pub name: String,
    pub node: i64,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub nodes: Vec<i64>,
    /// With a port, the name is an HTTPS service (ADR-0030): it resolves to
    /// the gateway of the tailnet, which passes requests to this TCP port of
    /// `node`. Without a gateway the name resolves to `node` itself.
    #[serde(default)]
    pub port: Option<u16>,
}

impl DnsRecord {
    pub fn visible_to(&self, node_id: i64, owner: Option<&str>) -> bool {
        if self.owner.is_none() && self.nodes.is_empty() {
            return true;
        }
        self.nodes.contains(&node_id) || (self.owner.is_some() && self.owner.as_deref() == owner)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TenantDns {
    /// Domain that service and device names live under (e.g. `ts.example.com`).
    /// `None` turns tailnet DNS off.
    #[serde(default)]
    pub base_domain: Option<String>,
    /// The tailnet's public name; device names are `<device>.<label>.<base_domain>`.
    #[serde(default)]
    pub tailnet_label: Option<String>,
    /// Resolvers for names under `base_domain` that have no record.
    #[serde(default)]
    pub upstream: Vec<String>,
    #[serde(default)]
    pub records: Vec<DnsRecord>,
}

/// True for one DNS label: lowercase letters, digits, inner hyphens, 1-63 chars.
pub fn is_dns_label(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 63
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
        && b[0] != b'-'
        && b[b.len() - 1] != b'-'
}

impl TenantDns {
    pub fn validate(&self) -> Result<(), &'static str> {
        if let Some(base) = &self.base_domain {
            if base.len() > 253 || base.split('.').count() < 2 || !base.split('.').all(is_dns_label) {
                return Err("base_domain must be a lowercase domain name");
            }
        } else if self.tailnet_label.is_some() || !self.records.is_empty() {
            return Err("base_domain is required when names are set");
        }
        if self.tailnet_label.as_deref().is_some_and(|l| !is_dns_label(l)) {
            return Err("tailnet_label must be one DNS label");
        }
        if self.upstream.len() > MAX_DNS_UPSTREAMS || self.upstream.iter().any(|u| u.parse::<IpAddr>().is_err()) {
            return Err("upstream must be up to 4 IP addresses");
        }
        if self.records.len() > MAX_DNS_RECORDS {
            return Err("too many DNS records");
        }
        for r in &self.records {
            if !is_dns_label(&r.name) {
                return Err("record name must be one DNS label");
            }
            if r.port == Some(0) {
                return Err("a service port must be 1 to 65535");
            }
            if r.nodes.len() > MAX_RECORD_NODES || r.owner.as_ref().is_some_and(|o| o.len() > 128) {
                return Err("record visibility list too large");
            }
            // A service name must not shadow the tailnet's device namespace
            if self.tailnet_label.as_deref() == Some(r.name.as_str()) {
                return Err("record name collides with the tailnet name");
            }
        }
        Ok(())
    }

    /// Suffix of device names (`<label>.<base_domain>`), when both are set.
    pub fn device_suffix(&self) -> Option<String> {
        Some(format!("{}.{}", self.tailnet_label.as_deref()?, self.base_domain.as_deref()?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dns() -> TenantDns {
        TenantDns {
            base_domain: Some("ts.example.com".into()),
            tailnet_label: Some("quiet-harbor".into()),
            upstream: vec!["1.1.1.1".into(), "2606:4700:4700::1111".into()],
            records: vec![DnsRecord { name: "notes".into(), node: 3, owner: Some("alice".into()), nodes: vec![], port: None }],
        }
    }

    #[test]
    fn valid_config_and_suffix() {
        assert!(dns().validate().is_ok());
        assert_eq!(dns().device_suffix().as_deref(), Some("quiet-harbor.ts.example.com"));
        assert!(TenantDns::default().validate().is_ok());
        assert_eq!(TenantDns::default().device_suffix(), None);
    }

    #[test]
    fn rejects_bad_input() {
        let mut d = dns();
        d.base_domain = Some("Not A Domain".into());
        assert!(d.validate().is_err());
        let mut d = dns();
        d.upstream = vec!["dns.example.com".into()];
        assert!(d.validate().is_err());
        let mut d = dns();
        d.records[0].name = "a.b".into();
        assert!(d.validate().is_err());
        let mut d = dns();
        d.records[0].name = "quiet-harbor".into();
        assert!(d.validate().is_err(), "a service name must not shadow device names");
        let mut d = dns();
        d.base_domain = None;
        assert!(d.validate().is_err());
    }

    #[test]
    fn record_visibility() {
        let private = DnsRecord { name: "n".into(), node: 1, owner: Some("alice".into()), nodes: vec![], port: None };
        assert!(private.visible_to(5, Some("alice")));
        assert!(!private.visible_to(5, Some("bob")));
        assert!(!private.visible_to(5, None));
        let listed = DnsRecord { name: "n".into(), node: 1, owner: Some("alice".into()), nodes: vec![9], port: None };
        assert!(listed.visible_to(9, Some("bob")));
        let everyone = DnsRecord { name: "n".into(), node: 1, owner: None, nodes: vec![], port: None };
        assert!(everyone.visible_to(7, None));
    }
}
