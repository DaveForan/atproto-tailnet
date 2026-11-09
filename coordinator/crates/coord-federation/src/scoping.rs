//! Federation scope model — local/regional/global tiers (ADR-0015).

use serde::{Deserialize, Serialize};

// ── Types ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FederationScope {
    Local,
    Regional,
    Global,
}

impl FederationScope {
    /// Priority value — higher means more specific / preferred.
    pub fn priority(self) -> u32 {
        match self {
            FederationScope::Local => 300,
            FederationScope::Regional => 200,
            FederationScope::Global => 100,
        }
    }
}

/// A route annotated with scope and optional measured latency for best-path selection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopedRoute {
    pub prefix: String,
    pub scope: FederationScope,
    pub origin_did: String,
    pub latency_ms: Option<f64>,
    pub preference: u32,
}

// ── Functions ──────────────────────────────────────────────────────────────────

/// Negotiate the narrowest common scope between two peers.
/// Returns the most specific (highest priority) scope that both sides support.
pub fn negotiate_scope(local: FederationScope, remote: FederationScope) -> FederationScope {
    // The narrowest (highest priority) scope wins. If they differ, pick the
    // one with the higher priority (i.e., the more restrictive one).
    if local.priority() >= remote.priority() {
        local
    } else {
        remote
    }
}

/// Select the best route from a set of candidates.
///
/// Selection strategy:
/// 1. If any routes have measured latency, pick the lowest-latency one.
/// 2. Otherwise, rank by (scope priority + preference), highest wins.
pub fn select_best_route(routes: &[ScopedRoute]) -> Option<&ScopedRoute> {
    if routes.is_empty() {
        return None;
    }

    // Prefer routes with measured latency.
    let with_latency: Vec<&ScopedRoute> = routes.iter().filter(|r| r.latency_ms.is_some()).collect();
    if !with_latency.is_empty() {
        return with_latency
            .into_iter()
            .min_by(|a, b| {
                a.latency_ms
                    .unwrap()
                    .partial_cmp(&b.latency_ms.unwrap())
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
    }

    // Fall back to scope priority + preference.
    routes.iter().max_by_key(|r| r.scope.priority() + r.preference)
}

/// Haversine distance in kilometres between two (lat, lon) coordinate pairs.
pub fn haversine_distance_km(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    const R: f64 = 6371.0; // Earth radius in km
    let d_lat = (lat2 - lat1).to_radians();
    let d_lon = (lon2 - lon1).to_radians();
    let a = (d_lat / 2.0).sin().powi(2)
        + lat1.to_radians().cos() * lat2.to_radians().cos() * (d_lon / 2.0).sin().powi(2);
    R * 2.0 * a.sqrt().atan2((1.0 - a).sqrt())
}

/// Returns `true` if the given distance (in km) qualifies as "local" (within 50 km).
pub fn is_local_candidate(distance_km: f64) -> bool {
    distance_km <= 50.0
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_priority_ordering() {
        assert!(FederationScope::Local.priority() > FederationScope::Regional.priority());
        assert!(FederationScope::Regional.priority() > FederationScope::Global.priority());
    }

    #[test]
    fn negotiate_scope_picks_narrowest() {
        assert_eq!(
            negotiate_scope(FederationScope::Local, FederationScope::Global),
            FederationScope::Local,
        );
        assert_eq!(
            negotiate_scope(FederationScope::Global, FederationScope::Regional),
            FederationScope::Regional,
        );
        assert_eq!(
            negotiate_scope(FederationScope::Local, FederationScope::Local),
            FederationScope::Local,
        );
    }

    #[test]
    fn select_best_route_empty() {
        assert!(select_best_route(&[]).is_none());
    }

    #[test]
    fn select_best_route_by_latency() {
        let routes = vec![
            ScopedRoute {
                prefix: "10.1.0.0/24".into(),
                scope: FederationScope::Global,
                origin_did: "did:web:a".into(),
                latency_ms: Some(50.0),
                preference: 100,
            },
            ScopedRoute {
                prefix: "10.1.0.0/24".into(),
                scope: FederationScope::Local,
                origin_did: "did:web:b".into(),
                latency_ms: Some(10.0),
                preference: 50,
            },
        ];
        let best = select_best_route(&routes).unwrap();
        // Lower latency wins, even though it has lower preference and broader scope.
        assert_eq!(best.origin_did, "did:web:b");
    }

    #[test]
    fn select_best_route_by_scope_and_preference() {
        let routes = vec![
            ScopedRoute {
                prefix: "10.1.0.0/24".into(),
                scope: FederationScope::Global,
                origin_did: "did:web:a".into(),
                latency_ms: None,
                preference: 100,
            },
            ScopedRoute {
                prefix: "10.1.0.0/24".into(),
                scope: FederationScope::Local,
                origin_did: "did:web:b".into(),
                latency_ms: None,
                preference: 50,
            },
        ];
        let best = select_best_route(&routes).unwrap();
        // Local (300) + 50 = 350 > Global (100) + 100 = 200
        assert_eq!(best.origin_did, "did:web:b");
    }

    #[test]
    fn haversine_same_point() {
        let d = haversine_distance_km(40.7128, -74.0060, 40.7128, -74.0060);
        assert!(d.abs() < 0.001);
    }

    #[test]
    fn haversine_nyc_to_london() {
        // NYC (40.7128, -74.0060) to London (51.5074, -0.1278) ~ 5570 km
        let d = haversine_distance_km(40.7128, -74.0060, 51.5074, -0.1278);
        assert!((d - 5570.0).abs() < 50.0, "distance was {d}");
    }

    #[test]
    fn is_local_candidate_threshold() {
        assert!(is_local_candidate(0.0));
        assert!(is_local_candidate(49.9));
        assert!(is_local_candidate(50.0));
        assert!(!is_local_candidate(50.1));
    }

    #[test]
    fn scope_serde_roundtrip() {
        let scope = FederationScope::Regional;
        let json = serde_json::to_string(&scope).unwrap();
        assert_eq!(json, r#""regional""#);
        let parsed: FederationScope = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, FederationScope::Regional);
    }
}
