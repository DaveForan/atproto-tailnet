//! Route exchange, loop prevention, and convergence (ADR-0014 section 4).

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use ipnetwork::IpNetwork;
use serde::{Deserialize, Serialize};

use crate::protocol::RouteAnnouncement;

// ── Types ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledRoute {
    pub prefix: String,
    pub origin_did: String,
    pub path_vector: Vec<String>,
    pub community_tags: Vec<String>,
    pub preference: u32,
    pub received_from: String, // session ID
    pub installed_at: DateTime<Utc>,
}

/// Route table with BGP-like path-vector logic: loop detection, scope validation,
/// best-path selection by preference, and per-session withdrawal.
#[derive(Debug, Clone)]
pub struct RouteTable {
    routes: HashMap<String, InstalledRoute>,
}

// ── Implementation ─────────────────────────────────────────────────────────────

impl RouteTable {
    pub fn new() -> Self {
        Self {
            routes: HashMap::new(),
        }
    }

    /// Process a route update: install announcements (rejecting loops and
    /// out-of-scope prefixes), remove withdrawals. Returns the list of newly
    /// installed prefixes.
    pub fn process_update(
        &mut self,
        announcements: &[RouteAnnouncement],
        withdrawals: &[String],
        session_id: &str,
        local_did: &str,
        agreed_cidrs: &[String],
    ) -> Vec<String> {
        // Process withdrawals first.
        for prefix in withdrawals {
            self.routes.remove(prefix);
        }

        let mut installed = Vec::new();

        for ann in announcements {
            // Loop detection: reject if our DID is already in the path vector.
            if ann.path_vector.iter().any(|did| did == local_did) {
                continue;
            }

            // Scope validation: prefix must fall within the agreed CIDRs.
            if !prefix_within_scope(&ann.prefix, agreed_cidrs) {
                continue;
            }

            // Best-path: only install if preference is strictly higher than existing.
            if let Some(existing) = self.routes.get(&ann.prefix) {
                if existing.preference >= ann.preference {
                    continue;
                }
            }

            self.routes.insert(
                ann.prefix.clone(),
                InstalledRoute {
                    prefix: ann.prefix.clone(),
                    origin_did: ann.origin_did.clone(),
                    path_vector: ann.path_vector.clone(),
                    community_tags: ann.community_tags.clone(),
                    preference: ann.preference,
                    received_from: session_id.to_string(),
                    installed_at: Utc::now(),
                },
            );
            installed.push(ann.prefix.clone());
        }

        installed
    }

    /// Returns routes suitable for export to a peer, excluding routes learned
    /// from `exclude_session`, with `local_did` appended to the path vector.
    pub fn get_exportable_routes(
        &self,
        exclude_session: &str,
        local_did: &str,
    ) -> Vec<RouteAnnouncement> {
        self.routes
            .values()
            .filter(|r| r.received_from != exclude_session)
            .map(|r| {
                let mut path = r.path_vector.clone();
                path.push(local_did.to_string());
                RouteAnnouncement {
                    prefix: r.prefix.clone(),
                    origin_did: r.origin_did.clone(),
                    path_vector: path,
                    community_tags: r.community_tags.clone(),
                    preference: r.preference,
                    origin_signature: String::new(),
                }
            })
            .collect()
    }

    /// Removes all routes learned from a given session. Returns the withdrawn prefixes.
    pub fn withdraw_session_routes(&mut self, session_id: &str) -> Vec<String> {
        let withdrawn: Vec<String> = self
            .routes
            .iter()
            .filter(|(_, r)| r.received_from == session_id)
            .map(|(prefix, _)| prefix.clone())
            .collect();

        for prefix in &withdrawn {
            self.routes.remove(prefix);
        }

        withdrawn
    }

    pub fn get_all_routes(&self) -> Vec<&InstalledRoute> {
        self.routes.values().collect()
    }

    pub fn get_route(&self, prefix: &str) -> Option<&InstalledRoute> {
        self.routes.get(prefix)
    }

    pub fn len(&self) -> usize {
        self.routes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.routes.is_empty()
    }
}

impl Default for RouteTable {
    fn default() -> Self {
        Self::new()
    }
}

// ── CIDR helpers ───────────────────────────────────────────────────────────────

/// Checks whether a prefix falls within at least one of the allowed CIDRs.
/// An empty list of allowed CIDRs means "allow all".
fn prefix_within_scope(prefix: &str, allowed_cidrs: &[String]) -> bool {
    if allowed_cidrs.is_empty() {
        return true;
    }
    allowed_cidrs
        .iter()
        .any(|cidr| cidr_contains_prefix(cidr, prefix))
}

/// Returns true if `scope` (a CIDR) fully contains `prefix` (also a CIDR).
/// Both the network address and mask length are checked: the prefix network bits
/// must fall within the scope, and the prefix mask must be at least as specific.
fn cidr_contains_prefix(scope: &str, prefix: &str) -> bool {
    let Ok(scope_net) = scope.parse::<IpNetwork>() else {
        return scope == prefix;
    };
    let Ok(prefix_net) = prefix.parse::<IpNetwork>() else {
        return scope == prefix;
    };

    // The prefix mask must be at least as specific (equal or longer).
    if prefix_net.prefix() < scope_net.prefix() {
        return false;
    }

    match (scope_net, prefix_net) {
        (IpNetwork::V4(s), IpNetwork::V4(p)) => s.is_supernet_of(p),
        (IpNetwork::V6(s), IpNetwork::V6(p)) => s.is_supernet_of(p),
        _ => false, // mixed v4/v6 never contains
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::RouteAnnouncement;

    fn ann(prefix: &str, origin: &str, path: &[&str], pref: u32) -> RouteAnnouncement {
        RouteAnnouncement {
            prefix: prefix.into(),
            origin_did: origin.into(),
            path_vector: path.iter().map(|s| s.to_string()).collect(),
            community_tags: vec![],
            preference: pref,
            origin_signature: String::new(),
        }
    }

    #[test]
    fn install_route_basic() {
        let mut table = RouteTable::new();
        let announcements = vec![ann("10.1.0.0/24", "did:web:origin", &["did:web:hop1"], 100)];
        let installed = table.process_update(&announcements, &[], "sess-1", "did:web:local", &[]);
        assert_eq!(installed, vec!["10.1.0.0/24"]);
        assert_eq!(table.len(), 1);

        let route = table.get_route("10.1.0.0/24").unwrap();
        assert_eq!(route.origin_did, "did:web:origin");
        assert_eq!(route.received_from, "sess-1");
    }

    #[test]
    fn reject_loop() {
        let mut table = RouteTable::new();
        // Path vector includes our local DID — should be rejected.
        let announcements = vec![ann(
            "10.1.0.0/24",
            "did:web:origin",
            &["did:web:hop1", "did:web:local"],
            100,
        )];
        let installed =
            table.process_update(&announcements, &[], "sess-1", "did:web:local", &[]);
        assert!(installed.is_empty());
        assert_eq!(table.len(), 0);
    }

    #[test]
    fn reject_out_of_scope() {
        let mut table = RouteTable::new();
        let announcements = vec![ann("192.168.1.0/24", "did:web:origin", &[], 100)];
        let agreed = vec!["10.0.0.0/8".into()];
        let installed =
            table.process_update(&announcements, &[], "sess-1", "did:web:local", &agreed);
        assert!(installed.is_empty());
    }

    #[test]
    fn accept_within_scope() {
        let mut table = RouteTable::new();
        let announcements = vec![ann("10.1.0.0/24", "did:web:origin", &[], 100)];
        let agreed = vec!["10.0.0.0/8".into()];
        let installed =
            table.process_update(&announcements, &[], "sess-1", "did:web:local", &agreed);
        assert_eq!(installed, vec!["10.1.0.0/24"]);
    }

    #[test]
    fn prefer_higher_preference() {
        let mut table = RouteTable::new();

        // Install low-preference route.
        table.process_update(
            &[ann("10.1.0.0/24", "did:web:a", &[], 50)],
            &[],
            "sess-1",
            "did:web:local",
            &[],
        );
        assert_eq!(table.get_route("10.1.0.0/24").unwrap().preference, 50);

        // Higher preference replaces it.
        table.process_update(
            &[ann("10.1.0.0/24", "did:web:b", &[], 100)],
            &[],
            "sess-2",
            "did:web:local",
            &[],
        );
        assert_eq!(table.get_route("10.1.0.0/24").unwrap().preference, 100);
        assert_eq!(table.get_route("10.1.0.0/24").unwrap().received_from, "sess-2");

        // Equal or lower preference does NOT replace.
        table.process_update(
            &[ann("10.1.0.0/24", "did:web:c", &[], 80)],
            &[],
            "sess-3",
            "did:web:local",
            &[],
        );
        assert_eq!(table.get_route("10.1.0.0/24").unwrap().received_from, "sess-2");
    }

    #[test]
    fn withdraw_removes_route() {
        let mut table = RouteTable::new();
        table.process_update(
            &[ann("10.1.0.0/24", "did:web:a", &[], 100)],
            &[],
            "sess-1",
            "did:web:local",
            &[],
        );
        assert_eq!(table.len(), 1);

        table.process_update(&[], &["10.1.0.0/24".into()], "sess-1", "did:web:local", &[]);
        assert_eq!(table.len(), 0);
    }

    #[test]
    fn withdraw_session_routes_removes_all_from_session() {
        let mut table = RouteTable::new();
        table.process_update(
            &[
                ann("10.1.0.0/24", "did:web:a", &[], 100),
                ann("10.2.0.0/24", "did:web:a", &[], 100),
            ],
            &[],
            "sess-1",
            "did:web:local",
            &[],
        );
        table.process_update(
            &[ann("10.3.0.0/24", "did:web:b", &[], 100)],
            &[],
            "sess-2",
            "did:web:local",
            &[],
        );
        assert_eq!(table.len(), 3);

        let withdrawn = table.withdraw_session_routes("sess-1");
        assert_eq!(withdrawn.len(), 2);
        assert_eq!(table.len(), 1);
        assert!(table.get_route("10.3.0.0/24").is_some());
    }

    #[test]
    fn exportable_routes_exclude_learned_from() {
        let mut table = RouteTable::new();
        table.process_update(
            &[ann("10.1.0.0/24", "did:web:a", &["did:web:hop"], 100)],
            &[],
            "sess-1",
            "did:web:local",
            &[],
        );
        table.process_update(
            &[ann("10.2.0.0/24", "did:web:b", &[], 100)],
            &[],
            "sess-2",
            "did:web:local",
            &[],
        );

        // Export for sess-1: should only include the route from sess-2.
        let exported = table.get_exportable_routes("sess-1", "did:web:local");
        assert_eq!(exported.len(), 1);
        assert_eq!(exported[0].prefix, "10.2.0.0/24");
        // Local DID should be appended to path vector.
        assert!(exported[0].path_vector.contains(&"did:web:local".to_string()));
    }

    #[test]
    fn cidr_containment_checks() {
        // 10.1.0.0/24 is within 10.0.0.0/8
        assert!(cidr_contains_prefix("10.0.0.0/8", "10.1.0.0/24"));
        // 192.168.1.0/24 is NOT within 10.0.0.0/8
        assert!(!cidr_contains_prefix("10.0.0.0/8", "192.168.1.0/24"));
        // A less-specific prefix is NOT within a more-specific scope.
        assert!(!cidr_contains_prefix("10.1.0.0/24", "10.0.0.0/8"));
        // Exact match.
        assert!(cidr_contains_prefix("10.1.0.0/24", "10.1.0.0/24"));
    }
}
