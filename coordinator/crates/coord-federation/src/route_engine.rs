//! Route exchange, loop prevention, and convergence (ADR-0014 section 4).

use std::collections::HashMap;

use coord_core::clock::{self, OffsetDateTime};
use ipnetwork::IpNetwork;
use serde::{Deserialize, Serialize};

use crate::protocol::RouteAnnouncement;


#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledRoute {
    pub prefix: String,
    pub origin_did: String,
    pub path_vector: Vec<String>,
    pub community_tags: Vec<String>,
    pub preference: u32,
    pub received_from: String, // session ID
    #[serde(with = "coord_core::clock::serde_rfc3339")]
    pub installed_at: OffsetDateTime,
}

/// Route table with BGP-like path-vector logic: loop detection, scope validation,
/// best-path selection by preference, and per-session withdrawal.
#[derive(Debug, Clone)]
pub struct RouteTable {
    routes: HashMap<String, InstalledRoute>,
}


impl RouteTable {
    pub fn new() -> Self {
        Self {
            routes: HashMap::new(),
        }
    }

    /// Applies withdrawals, then installs announcements that are loop-free and in scope.
    /// Returns the newly installed prefixes.
    pub fn process_update(
        &mut self,
        announcements: &[RouteAnnouncement],
        withdrawals: &[String],
        session_id: &str,
        local_did: &str,
        agreed_cidrs: &[String],
    ) -> Vec<String> {
        for prefix in withdrawals {
            self.routes.remove(prefix);
        }

        let mut installed = Vec::new();

        for ann in announcements {
            // Loop detection: reject a path vector that already contains our DID.
            if ann.path_vector.iter().any(|did| did == local_did) {
                continue;
            }

            if !prefix_within_scope(&ann.prefix, agreed_cidrs) {
                continue;
            }

            // Install only if preference is strictly higher than the existing route.
            if let Some(existing) = self.routes.get(&ann.prefix)
                && existing.preference >= ann.preference {
                    continue;
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
                    installed_at: clock::now(),
                },
            );
            installed.push(ann.prefix.clone());
        }

        installed
    }

    /// Returns routes to export to a peer, with `local_did` appended to each path vector.
    /// It skips routes learned from `exclude_session`.
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


/// Checks whether a prefix falls within at least one allowed CIDR.
/// # Security
/// An empty list allows nothing, so a link with no agreed CIDRs imports nothing.
/// Default routes (`/0`) and unparseable inputs never match.
pub fn prefix_within_scope(prefix: &str, allowed_cidrs: &[String]) -> bool {
    if allowed_cidrs.is_empty() {
        return false;
    }
    allowed_cidrs
        .iter()
        .any(|cidr| cidr_contains_prefix(cidr, prefix))
}

/// Returns true if `scope` contains the network bits of `prefix` and `prefix` has an equal or longer mask.
fn cidr_contains_prefix(scope: &str, prefix: &str) -> bool {
    let Ok(scope_net) = scope.parse::<IpNetwork>() else {
        return false;
    };
    let Ok(prefix_net) = prefix.parse::<IpNetwork>() else {
        return false;
    };

    // Default routes are never agreed or imported.
    if scope_net.prefix() == 0 || prefix_net.prefix() == 0 {
        return false;
    }

    if prefix_net.prefix() < scope_net.prefix() {
        return false;
    }

    match (scope_net, prefix_net) {
        (IpNetwork::V4(s), IpNetwork::V4(p)) => s.is_supernet_of(p),
        (IpNetwork::V6(s), IpNetwork::V6(p)) => s.is_supernet_of(p),
        _ => false, // mixed v4/v6 never contains
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::RouteAnnouncement;

    /// Agreed CIDRs covering every prefix the tests announce.
    fn scope() -> Vec<String> {
        vec!["10.0.0.0/8".into()]
    }

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
        let installed = table.process_update(&announcements, &[], "sess-1", "did:web:local", &scope());
        assert_eq!(installed, vec!["10.1.0.0/24"]);
        assert_eq!(table.len(), 1);

        let route = table.get_route("10.1.0.0/24").unwrap();
        assert_eq!(route.origin_did, "did:web:origin");
        assert_eq!(route.received_from, "sess-1");
    }

    #[test]
    fn reject_loop() {
        let mut table = RouteTable::new();
        // The path vector contains our local DID.
        let announcements = vec![ann(
            "10.1.0.0/24",
            "did:web:origin",
            &["did:web:hop1", "did:web:local"],
            100,
        )];
        let installed =
            table.process_update(&announcements, &[], "sess-1", "did:web:local", &scope());
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

        table.process_update(
            &[ann("10.1.0.0/24", "did:web:a", &[], 50)],
            &[],
            "sess-1",
            "did:web:local",
            &scope(),
        );
        assert_eq!(table.get_route("10.1.0.0/24").unwrap().preference, 50);

        table.process_update(
            &[ann("10.1.0.0/24", "did:web:b", &[], 100)],
            &[],
            "sess-2",
            "did:web:local",
            &scope(),
        );
        assert_eq!(table.get_route("10.1.0.0/24").unwrap().preference, 100);
        assert_eq!(table.get_route("10.1.0.0/24").unwrap().received_from, "sess-2");

        // Equal or lower preference does not replace.
        table.process_update(
            &[ann("10.1.0.0/24", "did:web:c", &[], 80)],
            &[],
            "sess-3",
            "did:web:local",
            &scope(),
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
            &scope(),
        );
        assert_eq!(table.len(), 1);

        table.process_update(&[], &["10.1.0.0/24".into()], "sess-1", "did:web:local", &scope());
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
            &scope(),
        );
        table.process_update(
            &[ann("10.3.0.0/24", "did:web:b", &[], 100)],
            &[],
            "sess-2",
            "did:web:local",
            &scope(),
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
            &scope(),
        );
        table.process_update(
            &[ann("10.2.0.0/24", "did:web:b", &[], 100)],
            &[],
            "sess-2",
            "did:web:local",
            &scope(),
        );

        // Export for sess-1 includes only the route from sess-2.
        let exported = table.get_exportable_routes("sess-1", "did:web:local");
        assert_eq!(exported.len(), 1);
        assert_eq!(exported[0].prefix, "10.2.0.0/24");
        assert!(exported[0].path_vector.contains(&"did:web:local".to_string()));
    }

    #[test]
    fn empty_scope_denies_everything() {
        assert!(!prefix_within_scope("10.1.0.0/24", &[]));
        let mut table = RouteTable::new();
        let installed = table.process_update(
            &[ann("10.1.0.0/24", "did:web:a", &[], 100)],
            &[],
            "sess-1",
            "did:web:local",
            &[],
        );
        assert!(installed.is_empty());
    }

    #[test]
    fn default_routes_and_garbage_never_in_scope() {
        assert!(!prefix_within_scope("0.0.0.0/0", &["0.0.0.0/0".into()]));
        assert!(!prefix_within_scope("::/0", &["::/0".into()]));
        assert!(!prefix_within_scope("10.0.0.0/8", &["0.0.0.0/0".into()]));
        assert!(!prefix_within_scope("garbage", &["garbage".into()]));
    }

    #[test]
    fn cidr_containment_checks() {
        assert!(cidr_contains_prefix("10.0.0.0/8", "10.1.0.0/24"));
        assert!(!cidr_contains_prefix("10.0.0.0/8", "192.168.1.0/24"));
        assert!(!cidr_contains_prefix("10.1.0.0/24", "10.0.0.0/8"));
        assert!(cidr_contains_prefix("10.1.0.0/24", "10.1.0.0/24"));
    }
}
