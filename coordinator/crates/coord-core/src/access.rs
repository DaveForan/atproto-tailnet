//! Per-tenant device access (ADR-0036): which devices may reach which.
//! `Member` mode allows same-owner devices plus the rules, and shows only those peers.
//! `Open` mode adds the tenant's ACL policy (allow-all without one), but only between the devices of
//! owners who chose it (`open_owners`) and devices without an owner. Every other device stays as in `Member` mode:
//! nobody but the owner can open a device to the tailnet.

use serde::{Deserialize, Serialize};

/// Upper bounds on a tenant's rule set (admin API input).
pub const MAX_ACCESS_RULES: usize = 5000;
pub const MAX_RULE_PORTS: usize = 64;
pub const MAX_RULE_SOURCES: usize = 256;
pub const MAX_OPEN_OWNERS: usize = 10_000;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccessMode {
    #[default]
    Open,
    Member,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccessProto {
    /// TCP, UDP and ICMP.
    #[default]
    Any,
    Tcp,
    Udp,
    Icmp,
}

impl AccessProto {
    /// IANA protocol numbers for the packet filter. `None` means the client default: TCP, UDP, ICMP.
    pub fn ip_protos(self) -> Option<Vec<i32>> {
        match self {
            AccessProto::Any => None,
            AccessProto::Tcp => Some(vec![6]),
            AccessProto::Udp => Some(vec![17]),
            AccessProto::Icmp => Some(vec![1, 58]),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccessPort {
    #[serde(default)]
    pub proto: AccessProto,
    pub first: u16,
    pub last: u16,
}

/// "These source devices may reach that device on those ports."
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccessRule {
    /// All devices of this owner (used when `src_nodes` is empty).
    #[serde(default)]
    pub src_owner: Option<String>,
    /// Specific source devices; when non-empty it replaces `src_owner`.
    #[serde(default)]
    pub src_nodes: Vec<i64>,
    pub dst_node: i64,
    pub ports: Vec<AccessPort>,
}

impl AccessRule {
    pub fn src_matches(&self, node_id: i64, owner: Option<&str>) -> bool {
        if !self.src_nodes.is_empty() {
            return self.src_nodes.contains(&node_id);
        }
        self.src_owner.is_some() && self.src_owner.as_deref() == owner
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TenantAccess {
    #[serde(default)]
    pub mode: AccessMode,
    #[serde(default)]
    pub rules: Vec<AccessRule>,
    /// Owners who put their own devices under the tenant's open policy. Used in `Open` mode only.
    #[serde(default)]
    pub open_owners: Vec<String>,
}

impl TenantAccess {
    /// True when a device of `owner` follows the open policy: the mode is `Open`, and the owner chose it or there is no owner.
    pub fn is_open_for(&self, owner: Option<&str>) -> bool {
        self.mode == AccessMode::Open && owner.is_none_or(|o| self.open_owners.iter().any(|x| x == o))
    }

    /// Checks size limits and port ranges.
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.rules.len() > MAX_ACCESS_RULES {
            return Err("too many access rules");
        }
        if self.open_owners.len() > MAX_OPEN_OWNERS || self.open_owners.iter().any(|o| o.is_empty() || o.len() > 128) {
            return Err("open_owners: too many, or an owner is empty or too long");
        }
        for r in &self.rules {
            if r.ports.is_empty() || r.ports.len() > MAX_RULE_PORTS {
                return Err("a rule needs 1 to 64 ports");
            }
            if r.src_nodes.len() > MAX_RULE_SOURCES {
                return Err("too many source devices in a rule");
            }
            if r.src_nodes.is_empty() && r.src_owner.as_deref().is_none_or(str::is_empty) {
                return Err("a rule needs src_owner or src_nodes");
            }
            if r.src_owner.as_ref().is_some_and(|o| o.len() > 128) {
                return Err("src_owner too long");
            }
            if r.ports.iter().any(|p| p.first > p.last) {
                return Err("port range first must not exceed last");
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(src_owner: Option<&str>, src_nodes: Vec<i64>) -> AccessRule {
        AccessRule {
            src_owner: src_owner.map(Into::into),
            src_nodes,
            dst_node: 9,
            ports: vec![AccessPort { proto: AccessProto::Tcp, first: 22, last: 22 }],
        }
    }

    #[test]
    fn source_matching() {
        let by_owner = rule(Some("alice"), vec![]);
        assert!(by_owner.src_matches(1, Some("alice")));
        assert!(!by_owner.src_matches(1, Some("bob")));
        assert!(!by_owner.src_matches(1, None));

        // Explicit source devices replace the owner match.
        let by_node = rule(Some("alice"), vec![3]);
        assert!(by_node.src_matches(3, Some("bob")));
        assert!(!by_node.src_matches(1, Some("alice")));
    }

    #[test]
    fn validation() {
        let ok = TenantAccess { mode: AccessMode::Member, rules: vec![rule(Some("a"), vec![])], ..Default::default() };
        assert!(ok.validate().is_ok());
        let no_src = TenantAccess { mode: AccessMode::Member, rules: vec![rule(None, vec![])], ..Default::default() };
        assert!(no_src.validate().is_err());
        let mut bad_range = rule(Some("a"), vec![]);
        bad_range.ports[0].first = 30;
        assert!(TenantAccess { mode: AccessMode::Member, rules: vec![bad_range], ..Default::default() }.validate().is_err());
        let mut no_ports = rule(Some("a"), vec![]);
        no_ports.ports.clear();
        assert!(TenantAccess { mode: AccessMode::Member, rules: vec![no_ports], ..Default::default() }.validate().is_err());
    }

    #[test]
    fn wire_format_is_snake_case_with_defaults() {
        let a: TenantAccess = serde_json::from_str(
            r#"{"mode":"member","rules":[{"src_owner":"u1","dst_node":4,"ports":[{"first":80,"last":80}]}]}"#,
        )
        .unwrap();
        assert_eq!(a.mode, AccessMode::Member);
        assert_eq!(a.rules[0].ports[0].proto, AccessProto::Any);
        assert_eq!(serde_json::from_str::<TenantAccess>("{}").unwrap(), TenantAccess::default());
        assert!(serde_json::from_str::<TenantAccess>(r#"{"mode":"member","extra":1}"#).is_err());
    }
}
