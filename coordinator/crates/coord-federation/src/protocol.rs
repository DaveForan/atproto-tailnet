//! Collective Federation Protocol (CFP) message types and constants (ADR-0014).

use serde::{Deserialize, Serialize};
use std::ops::RangeInclusive;

// ── Constants ──────────────────────────────────────────────────────────────────

pub const CFP_VERSION: &str = "1.0.0";
pub const MAX_MESSAGE_BYTES: usize = 1_048_576; // 1 MiB
pub const DEFAULT_KEEPALIVE_SECONDS: u32 = 60;
pub const KEEPALIVE_RANGE: RangeInclusive<u32> = 10..=300;
pub const HELLO_RATE_LIMIT_PER_DID: u32 = 10; // per minute
pub const CHALLENGE_EXPIRY_DEFAULT_SECONDS: u32 = 120;
pub const CHALLENGE_EXPIRY_MAX_SECONDS: u32 = 600;
pub const DRAIN_PERIOD_SECONDS: u32 = 30;

// ── Enums ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FederationType {
    Peer,
    ParentChild,
    Transit,
    Mesh,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Capability {
    RouteExchange,
    DnsForward,
    Transit,
    Mesh,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HandshakePhase {
    Idle,
    HelloSent,
    ChallengeSent,
    CommitSent,
    Established,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FederationPolicy {
    Open,
    Selective,
    Closed,
}

// ── Descriptor ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FederationDescriptor {
    pub collective_did: String,
    pub cfp_versions: Vec<String>,
    pub federation_policy: FederationPolicy,
    pub capabilities: Vec<Capability>,
    pub derp_endpoints: Vec<String>,
    pub broker_url: String,
    pub signature: String,
}

// ── Messages ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloMessage {
    pub collective_did: String,
    pub federation_type: FederationType,
    pub offered_cidrs: Vec<String>,
    pub capabilities: Vec<Capability>,
    pub protocol_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_id: Option<String>,
    pub signature: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChallengeMessage {
    pub collective_did: String,
    pub nonce: String,
    pub expires_at: String,
    pub accepted_type: FederationType,
    pub accepted_cidrs: Vec<String>,
    pub accepted_capabilities: Vec<Capability>,
    pub negotiated_version: String,
    pub negotiated_keepalive_seconds: u32,
    pub signature: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitMessage {
    pub collective_did: String,
    pub challenge_nonce: String,
    pub challenge_signature: String,
    pub initial_routes: Vec<RouteAnnouncement>,
    pub signature: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EstablishedMessage {
    pub session_id: String,
    pub collective_did: String,
    pub initial_routes: Vec<RouteAnnouncement>,
    pub keepalive_interval_seconds: u32,
    pub signature: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepaliveMessage {
    pub session_id: String,
    pub sequence_number: u64,
    pub timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteAnnouncement {
    pub prefix: String,
    pub origin_did: String,
    pub path_vector: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub community_tags: Vec<String>,
    pub preference: u32,
    pub origin_signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteUpdate {
    pub session_id: String,
    pub announcements: Vec<RouteAnnouncement>,
    pub withdrawals: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub continuation_token: Option<String>,
    pub signature: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokeMessage {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub permanent: bool,
    pub signature: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkRequestMessage {
    pub message_id: String,
    pub collective_did: String,
    pub broker_url: String,
    pub collective_name: String,
    pub federation_type: FederationType,
    pub offered_cidrs: Vec<String>,
    pub capabilities: Vec<Capability>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub signature: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkAcceptMessage {
    pub message_id: String,
    pub in_response_to: String,
    pub collective_did: String,
    pub broker_url: String,
    pub collective_name: String,
    pub accepted_cidrs: Vec<String>,
    pub signature: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkRejectMessage {
    pub message_id: String,
    pub in_response_to: String,
    pub collective_did: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub signature: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkRevokeMessage {
    pub message_id: String,
    pub collective_did: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub permanent: bool,
    pub signature: String,
    pub timestamp: String,
}

// ── Tagged union ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum CfpMessage {
    #[serde(rename = "HELLO")]
    Hello(HelloMessage),
    #[serde(rename = "CHALLENGE")]
    Challenge(ChallengeMessage),
    #[serde(rename = "COMMIT")]
    Commit(CommitMessage),
    #[serde(rename = "ESTABLISHED")]
    Established(EstablishedMessage),
    #[serde(rename = "KEEPALIVE")]
    Keepalive(KeepaliveMessage),
    #[serde(rename = "ROUTE_UPDATE")]
    RouteUpdate(RouteUpdate),
    #[serde(rename = "REVOKE")]
    Revoke(RevokeMessage),
    #[serde(rename = "LINK_REQUEST")]
    LinkRequest(LinkRequestMessage),
    #[serde(rename = "LINK_ACCEPT")]
    LinkAccept(LinkAcceptMessage),
    #[serde(rename = "LINK_REJECT")]
    LinkReject(LinkRejectMessage),
    #[serde(rename = "LINK_REVOKE")]
    LinkRevoke(LinkRevokeMessage),
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn federation_type_serde_kebab_case() {
        let ft = FederationType::ParentChild;
        let json = serde_json::to_string(&ft).unwrap();
        assert_eq!(json, r#""parent-child""#);

        let rt: FederationType = serde_json::from_str(r#""transit""#).unwrap();
        assert_eq!(rt, FederationType::Transit);
    }

    #[test]
    fn capability_serde_kebab_case() {
        let cap = Capability::RouteExchange;
        let json = serde_json::to_string(&cap).unwrap();
        assert_eq!(json, r#""route-exchange""#);

        let rt: Capability = serde_json::from_str(r#""dns-forward""#).unwrap();
        assert_eq!(rt, Capability::DnsForward);
    }

    #[test]
    fn cfp_message_hello_roundtrip() {
        let hello = CfpMessage::Hello(HelloMessage {
            collective_did: "did:web:example.com:collective:test".into(),
            federation_type: FederationType::Peer,
            offered_cidrs: vec!["10.0.0.0/24".into()],
            capabilities: vec![Capability::RouteExchange],
            protocol_version: CFP_VERSION.into(),
            mesh_id: None,
            signature: "sig123".into(),
            timestamp: "2026-01-01T00:00:00Z".into(),
        });

        let json = serde_json::to_string(&hello).unwrap();
        assert!(json.contains(r#""type":"HELLO""#));

        let parsed: CfpMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            CfpMessage::Hello(h) => {
                assert_eq!(h.collective_did, "did:web:example.com:collective:test");
                assert_eq!(h.federation_type, FederationType::Peer);
            }
            _ => panic!("expected Hello variant"),
        }
    }

    #[test]
    fn cfp_message_keepalive_roundtrip() {
        let ka = CfpMessage::Keepalive(KeepaliveMessage {
            session_id: "sess-1".into(),
            sequence_number: 42,
            timestamp: "2026-01-01T00:00:00Z".into(),
            signature: None,
        });

        let json = serde_json::to_string(&ka).unwrap();
        assert!(json.contains(r#""type":"KEEPALIVE""#));
        assert!(json.contains(r#""sequenceNumber":42"#));

        let parsed: CfpMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            CfpMessage::Keepalive(k) => {
                assert_eq!(k.session_id, "sess-1");
                assert_eq!(k.sequence_number, 42);
                assert!(k.signature.is_none());
            }
            _ => panic!("expected Keepalive variant"),
        }
    }

    #[test]
    fn cfp_message_revoke_roundtrip() {
        let revoke = CfpMessage::Revoke(RevokeMessage {
            session_id: "sess-2".into(),
            reason: Some("maintenance".into()),
            permanent: false,
            signature: "sig456".into(),
            timestamp: "2026-01-01T00:00:00Z".into(),
        });

        let json = serde_json::to_string(&revoke).unwrap();
        assert!(json.contains(r#""type":"REVOKE""#));

        let parsed: CfpMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            CfpMessage::Revoke(r) => {
                assert_eq!(r.reason.as_deref(), Some("maintenance"));
                assert!(!r.permanent);
            }
            _ => panic!("expected Revoke variant"),
        }
    }

    #[test]
    fn cfp_message_route_update_roundtrip() {
        let update = CfpMessage::RouteUpdate(RouteUpdate {
            session_id: "sess-3".into(),
            announcements: vec![RouteAnnouncement {
                prefix: "10.1.0.0/16".into(),
                origin_did: "did:web:origin".into(),
                path_vector: vec!["did:web:hop1".into()],
                community_tags: vec![],
                preference: 100,
                origin_signature: "osig".into(),
            }],
            withdrawals: vec!["10.2.0.0/16".into()],
            continuation_token: None,
            signature: "sig789".into(),
            timestamp: "2026-01-01T00:00:00Z".into(),
        });

        let json = serde_json::to_string(&update).unwrap();
        assert!(json.contains(r#""type":"ROUTE_UPDATE""#));

        let parsed: CfpMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            CfpMessage::RouteUpdate(u) => {
                assert_eq!(u.announcements.len(), 1);
                assert_eq!(u.withdrawals, vec!["10.2.0.0/16"]);
            }
            _ => panic!("expected RouteUpdate variant"),
        }
    }

    #[test]
    fn cfp_message_link_lifecycle_roundtrip() {
        let req = CfpMessage::LinkRequest(LinkRequestMessage {
            message_id: "msg-1".into(),
            collective_did: "did:web:requester".into(),
            broker_url: "https://broker.example.com".into(),
            collective_name: "My Collective".into(),
            federation_type: FederationType::Mesh,
            offered_cidrs: vec!["10.0.0.0/8".into()],
            capabilities: vec![Capability::Mesh],
            message: Some("Let's federate!".into()),
            signature: "sig-req".into(),
            timestamp: "2026-01-01T00:00:00Z".into(),
        });

        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains(r#""type":"LINK_REQUEST""#));

        let parsed: CfpMessage = serde_json::from_str(&json).unwrap();
        assert!(matches!(parsed, CfpMessage::LinkRequest(_)));
    }
}
