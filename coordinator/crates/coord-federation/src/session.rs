//! Federation session lifecycle — keepalive and revocation (ADR-0014 sections 5-6).

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use crate::protocol::{
    Capability, FederationType, KeepaliveMessage, RevokeMessage,
    DEFAULT_KEEPALIVE_SECONDS, DRAIN_PERIOD_SECONDS,
};

// ── Types ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Connecting,
    Established,
    Degraded,
    Down,
    Draining,
    Revoked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FederationSession {
    pub session_id: String,
    pub local_did: String,
    pub remote_did: String,
    pub status: SessionStatus,
    pub federation_type: FederationType,
    pub negotiated_cidrs: Vec<String>,
    pub capabilities: Vec<Capability>,
    pub keepalive_interval_seconds: u32,
    pub last_keepalive_sent: DateTime<Utc>,
    pub last_keepalive_received: DateTime<Utc>,
    pub missed_keepalives: u32,
    pub sequence_number: u64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

// ── Implementation ─────────────────────────────────────────────────────────────

impl FederationSession {
    pub fn new(
        session_id: String,
        local_did: String,
        remote_did: String,
        federation_type: FederationType,
        cidrs: Vec<String>,
        capabilities: Vec<Capability>,
        keepalive_seconds: u32,
    ) -> Self {
        let now = Utc::now();
        Self {
            session_id,
            local_did,
            remote_did,
            status: SessionStatus::Established,
            federation_type,
            negotiated_cidrs: cidrs,
            capabilities,
            keepalive_interval_seconds: keepalive_seconds,
            last_keepalive_sent: now,
            last_keepalive_received: now,
            missed_keepalives: 0,
            sequence_number: 0,
            created_at: now,
            updated_at: now,
        }
    }

    /// Generates a keepalive message, advancing the sequence counter.
    pub fn generate_keepalive(&mut self) -> KeepaliveMessage {
        self.sequence_number += 1;
        let now = Utc::now();
        self.last_keepalive_sent = now;
        self.updated_at = now;

        KeepaliveMessage {
            session_id: self.session_id.clone(),
            sequence_number: self.sequence_number,
            timestamp: now.to_rfc3339(),
            signature: None,
        }
    }

    /// Records that a keepalive was received from the remote peer.
    pub fn handle_keepalive_received(&mut self) {
        let now = Utc::now();
        self.last_keepalive_received = now;
        self.missed_keepalives = 0;
        if self.status == SessionStatus::Degraded {
            self.status = SessionStatus::Established;
        }
        self.updated_at = now;
    }

    /// Checks keepalive health based on elapsed time since last received keepalive.
    /// Updates status to Degraded (3+ missed) or Down (5+ missed).
    pub fn check_keepalive_health(&mut self) -> SessionStatus {
        let now = Utc::now();
        let interval_secs = if self.keepalive_interval_seconds > 0 {
            self.keepalive_interval_seconds
        } else {
            DEFAULT_KEEPALIVE_SECONDS
        };
        let interval = Duration::seconds(i64::from(interval_secs));
        let elapsed = now - self.last_keepalive_received;

        // Calculate how many keepalive intervals have been missed.
        let missed_count = if interval.num_milliseconds() > 0 {
            (elapsed.num_milliseconds() / interval.num_milliseconds()) as u32
        } else {
            0
        };

        self.missed_keepalives = missed_count;
        self.updated_at = now;

        if missed_count >= 5 {
            self.status = SessionStatus::Down;
            return SessionStatus::Down;
        }
        if missed_count >= 3 {
            self.status = SessionStatus::Degraded;
            return SessionStatus::Degraded;
        }

        self.status.clone()
    }

    /// Initiates a revoke, transitioning to Draining. Returns the revoke message
    /// and the drain deadline (after which finalize_revoke should be called).
    pub fn initiate_revoke(
        &mut self,
        reason: Option<String>,
        permanent: bool,
    ) -> (RevokeMessage, DateTime<Utc>) {
        let now = Utc::now();
        self.status = SessionStatus::Draining;
        self.updated_at = now;

        let message = RevokeMessage {
            session_id: self.session_id.clone(),
            reason,
            permanent,
            signature: String::new(),
            timestamp: now.to_rfc3339(),
        };

        let drain_deadline = now + Duration::seconds(i64::from(DRAIN_PERIOD_SECONDS));
        (message, drain_deadline)
    }

    /// Finalizes a revoke after the drain period expires.
    pub fn finalize_revoke(&mut self) {
        self.status = SessionStatus::Revoked;
        self.updated_at = Utc::now();
    }

    /// Handles a revoke message from the remote peer.
    pub fn handle_remote_revoke(&mut self) {
        self.status = SessionStatus::Revoked;
        self.updated_at = Utc::now();
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::FederationType;

    fn test_session() -> FederationSession {
        FederationSession::new(
            "sess-test".into(),
            "did:web:local".into(),
            "did:web:remote".into(),
            FederationType::Peer,
            vec!["10.0.0.0/24".into()],
            vec![Capability::RouteExchange],
            60,
        )
    }

    #[test]
    fn new_session_is_established() {
        let session = test_session();
        assert_eq!(session.status, SessionStatus::Established);
        assert_eq!(session.missed_keepalives, 0);
        assert_eq!(session.sequence_number, 0);
    }

    #[test]
    fn generate_keepalive_increments_sequence() {
        let mut session = test_session();
        let ka1 = session.generate_keepalive();
        assert_eq!(ka1.sequence_number, 1);
        assert_eq!(ka1.session_id, "sess-test");

        let ka2 = session.generate_keepalive();
        assert_eq!(ka2.sequence_number, 2);
        assert_eq!(session.sequence_number, 2);
    }

    #[test]
    fn handle_keepalive_received_resets_missed() {
        let mut session = test_session();
        session.missed_keepalives = 3;
        session.status = SessionStatus::Degraded;

        session.handle_keepalive_received();
        assert_eq!(session.missed_keepalives, 0);
        assert_eq!(session.status, SessionStatus::Established);
    }

    #[test]
    fn check_health_fresh_session_stays_established() {
        let mut session = test_session();
        let status = session.check_keepalive_health();
        assert_eq!(status, SessionStatus::Established);
    }

    #[test]
    fn check_health_degraded_after_3_missed() {
        let mut session = test_session();
        // Simulate 3 missed keepalives (3 * 60s = 180s ago).
        session.last_keepalive_received = Utc::now() - Duration::seconds(180);
        let status = session.check_keepalive_health();
        assert_eq!(status, SessionStatus::Degraded);
    }

    #[test]
    fn check_health_down_after_5_missed() {
        let mut session = test_session();
        // Simulate 5 missed keepalives (5 * 60s = 300s ago).
        session.last_keepalive_received = Utc::now() - Duration::seconds(300);
        let status = session.check_keepalive_health();
        assert_eq!(status, SessionStatus::Down);
    }

    #[test]
    fn revoke_lifecycle() {
        let mut session = test_session();

        // Initiate revoke.
        let (msg, deadline) = session.initiate_revoke(Some("maintenance".into()), false);
        assert_eq!(session.status, SessionStatus::Draining);
        assert_eq!(msg.session_id, "sess-test");
        assert!(!msg.permanent);
        assert!(deadline > Utc::now());

        // Finalize revoke.
        session.finalize_revoke();
        assert_eq!(session.status, SessionStatus::Revoked);
    }

    #[test]
    fn handle_remote_revoke_sets_revoked() {
        let mut session = test_session();
        session.handle_remote_revoke();
        assert_eq!(session.status, SessionStatus::Revoked);
    }

    #[test]
    fn session_serde_roundtrip() {
        let session = test_session();
        let json = serde_json::to_string(&session).unwrap();
        let parsed: FederationSession = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.session_id, session.session_id);
        assert_eq!(parsed.status, SessionStatus::Established);
    }
}
