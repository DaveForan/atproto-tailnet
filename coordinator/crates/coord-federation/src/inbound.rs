//! Inbound CFP message handlers (Tier 3).
//!
//! Ported from `src/routes/federation-messages.ts` (841 lines).
//! Pure business logic handlers — NOT axum handlers. The coord-api crate
//! wraps these in HTTP handlers.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tracing::info;

use coord_core::types::{
    BrokerSessionStatus, FederationLink, LinkDirection, LinkId, LinkStatus, TenantId,
};

use crate::abuse::{RateLimiter, ReplayGuard};
use crate::auth::{filter_imported_prefixes, is_fresh};
use crate::broker::BrokerConfig;
use crate::handshake::{self, HandshakeCallbacks, HandshakeState};
use crate::protocol::{
    ChallengeMessage, CommitMessage, EstablishedMessage, HelloMessage, KeepaliveMessage,
    LinkAcceptMessage, LinkRejectMessage, LinkRequestMessage, LinkRevokeMessage, RevokeMessage,
    CFP_VERSION,
};
use crate::store::FederationStore;

// ── Constants ──────────────────────────────────────────────────────────────────

use crate::abuse::MAX_PENDING_PER_COLLECTIVE;

/// How long a pending handshake state remains valid.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(300);

// ── Error types ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorBody {
    pub error: String,
}

/// Typed errors for inbound message handling, mapping cleanly to HTTP status codes.
#[derive(Debug)]
pub enum InboundError {
    BadRequest(String),
    NotFound(String),
    Forbidden(String),
    RateLimited,
    Conflict(String),
    Gone(String),
}

impl InboundError {
    pub fn status_code(&self) -> u16 {
        match self {
            InboundError::BadRequest(_) => 400,
            InboundError::NotFound(_) => 404,
            InboundError::Forbidden(_) => 403,
            InboundError::RateLimited => 429,
            InboundError::Conflict(_) => 409,
            InboundError::Gone(_) => 410,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            InboundError::BadRequest(m)
            | InboundError::NotFound(m)
            | InboundError::Forbidden(m)
            | InboundError::Conflict(m)
            | InboundError::Gone(m) => m,
            InboundError::RateLimited => "Too many requests",
        }
    }
}

impl std::fmt::Display for InboundError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.message(), self.status_code())
    }
}

impl std::error::Error for InboundError {}

// ── Pending handshake state ───────────────────────────────────────────────────

struct PendingHandshake {
    state: HandshakeState,
    local_tenant_id: TenantId,
    link_id: LinkId,
    #[allow(dead_code)]
    remote_cidrs: Vec<String>,
    expires_at: DateTime<Utc>,
}

const MAX_DID_LEN: usize = 512;
const MAX_URL_LEN: usize = 2048;
const MAX_CIDR_LEN: usize = 64;
const MAX_CIDRS: usize = 64;
const MAX_NAME_LEN: usize = 256;

fn validate_did(did: &str) -> Result<(), InboundError> {
    if did.len() > MAX_DID_LEN || !did.starts_with("did:") {
        return Err(InboundError::BadRequest("Invalid DID".into()));
    }
    Ok(())
}

fn validate_cidrs(cidrs: &[String]) -> Result<(), InboundError> {
    if cidrs.len() > MAX_CIDRS {
        return Err(InboundError::BadRequest("Too many CIDRs".into()));
    }
    for cidr in cidrs {
        if cidr.len() > MAX_CIDR_LEN {
            return Err(InboundError::BadRequest("CIDR too long".into()));
        }
    }
    Ok(())
}

// ── InboundHandler ────────────────────────────────────────────────────────────

pub struct InboundHandler<S: FederationStore + ?Sized> {
    store: Arc<S>,
    config: BrokerConfig,
    /// Pending handshakes keyed by the challenge nonce.
    pending_handshakes: Mutex<HashMap<String, PendingHandshake>>,
    /// Per-DID rate limiter for inbound federation messages.
    rate_limiter: Mutex<RateLimiter>,
    /// Replay guard keyed by message nonce/timestamp to prevent replays.
    replay_guard: Mutex<ReplayGuard>,
}

const RATE_LIMIT_WINDOW_MS: u64 = 60_000;
const RATE_LIMIT_MAX_HITS: u32 = 60;
const REPLAY_WINDOW_SECS: u64 = 300;

impl<S: FederationStore + ?Sized> InboundHandler<S> {
    pub fn new(store: Arc<S>, config: BrokerConfig) -> Self {
        Self {
            store,
            config,
            pending_handshakes: Mutex::new(HashMap::new()),
            rate_limiter: Mutex::new(RateLimiter::new(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_HITS)),
            replay_guard: Mutex::new(ReplayGuard::new(Duration::from_secs(REPLAY_WINDOW_SECS))),
        }
    }

    async fn check_rate_limit(&self, key: &str) -> Result<(), InboundError> {
        let mut limiter = self.rate_limiter.lock().await;
        if !limiter.check(key) {
            return Err(InboundError::RateLimited);
        }
        Ok(())
    }

    async fn check_replay(&self, nonce: &str) -> Result<(), InboundError> {
        let mut guard = self.replay_guard.lock().await;
        if !guard.check(nonce) {
            return Err(InboundError::BadRequest("Duplicate message (replay detected)".into()));
        }
        Ok(())
    }

    pub fn store(&self) -> &S {
        &self.store
    }

    /// Handle an inbound HELLO message.
    ///
    /// Validates the sender has an active link with the recipient, runs the
    /// handshake state machine, and returns a CHALLENGE.
    pub async fn handle_hello(
        &self,
        recipient_tenant_id: TenantId,
        recipient_did: &str,
        hello: HelloMessage,
        callbacks: &dyn HandshakeCallbacks,
    ) -> Result<ChallengeMessage, InboundError> {
        validate_did(&hello.collective_did)?;
        validate_cidrs(&hello.offered_cidrs)?;

        self.check_rate_limit(&hello.collective_did).await?;
        self.check_replay(&hello.timestamp).await?;

        if !is_fresh(&hello.timestamp) {
            return Err(InboundError::BadRequest("Message timestamp too old or too new".into()));
        }

        // The sender must have an active link with us.
        let link = self
            .store
            .find_active_link(recipient_tenant_id, &hello.collective_did)
            .await
            .map_err(|e| InboundError::BadRequest(format!("Store error: {e}")))?
            .ok_or_else(|| {
                InboundError::Forbidden(format!(
                    "No active federation link with {}",
                    hello.collective_did
                ))
            })?;

        // Run the handshake state machine.
        let state = handshake::create_handshake(recipient_did);
        let (state, challenge) = handshake::handle_hello(
            state,
            &hello,
            &link.local_cidrs,
            &self.config.local_capabilities,
            callbacks,
        )
        .await
        .map_err(|(_state, err)| InboundError::BadRequest(err))?;

        // Store the pending handshake keyed by the challenge nonce.
        let nonce = challenge.nonce.clone();
        let pending = PendingHandshake {
            state,
            local_tenant_id: recipient_tenant_id,
            link_id: link.id,
            remote_cidrs: hello.offered_cidrs,
            expires_at: Utc::now() + chrono::Duration::from_std(HANDSHAKE_TIMEOUT)
                .unwrap_or(chrono::Duration::seconds(300)),
        };

        {
            let mut handshakes = self.pending_handshakes.lock().await;
            // Cleanup expired handshakes while we're here.
            let now = Utc::now();
            handshakes.retain(|_, h| h.expires_at > now);
            handshakes.insert(nonce, pending);
        }

        info!(
            recipient_tenant = %recipient_tenant_id,
            sender_did = %hello.collective_did,
            "HELLO processed, CHALLENGE issued"
        );

        Ok(challenge)
    }

    /// Handle an inbound COMMIT message.
    ///
    /// Looks up the pending handshake by the challenge nonce, verifies the
    /// commit, and returns an ESTABLISHED message.
    pub async fn handle_commit(
        &self,
        recipient_tenant_id: TenantId,
        commit: CommitMessage,
        callbacks: &dyn HandshakeCallbacks,
    ) -> Result<EstablishedMessage, InboundError> {
        self.check_replay(&commit.timestamp).await?;

        if !is_fresh(&commit.timestamp) {
            return Err(InboundError::BadRequest("Message timestamp too old or too new".into()));
        }

        // Look up the pending handshake.
        let pending = {
            let mut handshakes = self.pending_handshakes.lock().await;
            handshakes.remove(&commit.challenge_nonce)
        };

        let pending = pending.ok_or_else(|| {
            InboundError::NotFound("No pending handshake for this challenge nonce".into())
        })?;

        // Verify tenant matches.
        if pending.local_tenant_id != recipient_tenant_id {
            return Err(InboundError::Forbidden("Tenant mismatch".into()));
        }

        // Check expiry.
        if pending.expires_at < Utc::now() {
            return Err(InboundError::Gone("Handshake expired".into()));
        }

        // Run the handshake state machine.
        let (state, established) = handshake::handle_commit(pending.state, &commit, callbacks)
            .await
            .map_err(|(_state, err)| InboundError::BadRequest(err))?;

        // Filter imported prefixes: only accept what was agreed on the link.
        let link = self
            .store
            .get_link(pending.link_id)
            .await
            .map_err(|e| InboundError::BadRequest(format!("Store error: {e}")))?
            .ok_or_else(|| InboundError::NotFound("Link not found".into()))?;

        let imported_prefixes = filter_imported_prefixes(
            &commit.initial_routes,
            &link.peer_cidrs,
            &commit.collective_did,
        );

        // Mark the session as established in the store.
        let cfp_session_id = state
            .session_id
            .clone()
            .unwrap_or_else(|| established.session_id.clone());

        self.store
            .update_session_established(
                pending.link_id,
                recipient_tenant_id,
                cfp_session_id,
                imported_prefixes,
            )
            .await
            .map_err(|e| InboundError::BadRequest(format!("Store error: {e}")))?;

        info!(
            recipient_tenant = %recipient_tenant_id,
            sender_did = %commit.collective_did,
            session_id = %established.session_id,
            "COMMIT processed, session ESTABLISHED"
        );

        Ok(established)
    }

    /// Handle an inbound KEEPALIVE message.
    ///
    /// Finds the session by CFP session ID, updates the keepalive timestamp,
    /// and returns an ack keepalive.
    pub async fn handle_keepalive(
        &self,
        recipient_tenant_id: TenantId,
        keepalive: KeepaliveMessage,
    ) -> Result<KeepaliveMessage, InboundError> {
        self.check_replay(&keepalive.timestamp).await?;

        if !is_fresh(&keepalive.timestamp) {
            return Err(InboundError::BadRequest("Message timestamp too old or too new".into()));
        }

        let session = self
            .store
            .find_session_by_cfp_id(&keepalive.session_id, recipient_tenant_id)
            .await
            .map_err(|e| InboundError::BadRequest(format!("Store error: {e}")))?
            .ok_or_else(|| {
                InboundError::NotFound(format!(
                    "No session with CFP ID {}",
                    keepalive.session_id
                ))
            })?;

        // Update keepalive timestamp.
        self.store
            .update_session_keepalive(session.id)
            .await
            .map_err(|e| InboundError::BadRequest(format!("Store error: {e}")))?;

        // If session was degraded, mark it established again.
        if session.status == BrokerSessionStatus::Degraded {
            self.store
                .update_session_status(session.id, BrokerSessionStatus::Established, None)
                .await
                .map_err(|e| InboundError::BadRequest(format!("Store error: {e}")))?;
        }

        // Return an ack keepalive.
        Ok(KeepaliveMessage {
            session_id: keepalive.session_id,
            sequence_number: keepalive.sequence_number,
            timestamp: Utc::now().to_rfc3339(),
            signature: None,
        })
    }

    /// Handle an inbound REVOKE message.
    ///
    /// Finds the session and tears it down.
    pub async fn handle_revoke(
        &self,
        recipient_tenant_id: TenantId,
        revoke: RevokeMessage,
    ) -> Result<(), InboundError> {
        if !is_fresh(&revoke.timestamp) {
            return Err(InboundError::BadRequest("Message timestamp too old or too new".into()));
        }

        let session = self
            .store
            .find_session_by_cfp_id(&revoke.session_id, recipient_tenant_id)
            .await
            .map_err(|e| InboundError::BadRequest(format!("Store error: {e}")))?
            .ok_or_else(|| {
                InboundError::NotFound(format!(
                    "No session with CFP ID {}",
                    revoke.session_id
                ))
            })?;

        info!(
            session_id = %session.id,
            cfp_session_id = %revoke.session_id,
            reason = ?revoke.reason,
            permanent = %revoke.permanent,
            "remote revoke received, tearing down session"
        );

        self.store
            .delete_session(session.id)
            .await
            .map_err(|e| InboundError::BadRequest(format!("Store error: {e}")))?;

        Ok(())
    }

    /// Handle an inbound LINK_REQUEST message.
    ///
    /// Creates a new pending incoming link.
    pub async fn handle_link_request(
        &self,
        recipient_tenant_id: TenantId,
        msg: LinkRequestMessage,
    ) -> Result<(), InboundError> {
        validate_did(&msg.collective_did)?;
        validate_cidrs(&msg.offered_cidrs)?;
        if msg.broker_url.len() > MAX_URL_LEN {
            return Err(InboundError::BadRequest("Broker URL too long".into()));
        }
        if msg.collective_name.len() > MAX_NAME_LEN {
            return Err(InboundError::BadRequest("Collective name too long".into()));
        }

        self.check_rate_limit(&msg.collective_did).await?;
        self.check_replay(&msg.timestamp).await?;

        if !is_fresh(&msg.timestamp) {
            return Err(InboundError::BadRequest("Message timestamp too old or too new".into()));
        }

        // Check if we already have an active link with this peer.
        let existing = self
            .store
            .find_active_link(recipient_tenant_id, &msg.collective_did)
            .await
            .map_err(|e| InboundError::BadRequest(format!("Store error: {e}")))?;
        if existing.is_some() {
            return Err(InboundError::Conflict(format!(
                "Already have an active link with {}",
                msg.collective_did
            )));
        }

        // Rate limit: expire oldest pending if over limit.
        self.store
            .expire_oldest_pending(recipient_tenant_id, MAX_PENDING_PER_COLLECTIVE)
            .await
            .map_err(|e| InboundError::BadRequest(format!("Store error: {e}")))?;

        let now = Utc::now();
        let link = FederationLink {
            id: LinkId::generate(),
            local_tenant_id: recipient_tenant_id,
            peer_did: msg.collective_did.clone(),
            peer_broker_url: Some(msg.broker_url),
            peer_name: Some(msg.collective_name),
            direction: LinkDirection::Incoming,
            status: LinkStatus::Pending,
            local_cidrs: vec![],
            peer_cidrs: msg.offered_cidrs,
            protocol_version: Some(CFP_VERSION.to_string()),
            message: msg.message,
            signed_request: Some(msg.signature),
            created_at: now,
            updated_at: now,
        };

        self.store
            .create_link(link)
            .await
            .map_err(|e| InboundError::BadRequest(format!("Store error: {e}")))?;

        info!(
            recipient_tenant = %recipient_tenant_id,
            sender_did = %msg.collective_did,
            "link request received and stored"
        );

        Ok(())
    }

    /// Handle an inbound LINK_ACCEPT message.
    ///
    /// Finds the corresponding outgoing pending link and activates it.
    pub async fn handle_link_accept(
        &self,
        recipient_tenant_id: TenantId,
        msg: LinkAcceptMessage,
    ) -> Result<(), InboundError> {
        validate_did(&msg.collective_did)?;
        if !is_fresh(&msg.timestamp) {
            return Err(InboundError::BadRequest("Message timestamp too old or too new".into()));
        }

        let link = self
            .store
            .find_pending_outgoing_link(recipient_tenant_id, &msg.collective_did)
            .await
            .map_err(|e| InboundError::BadRequest(format!("Store error: {e}")))?
            .ok_or_else(|| {
                InboundError::NotFound(format!(
                    "No pending outgoing link with {}",
                    msg.collective_did
                ))
            })?;

        self.store
            .update_link_on_accept(
                link.id,
                msg.accepted_cidrs,
                msg.broker_url,
                msg.collective_name,
            )
            .await
            .map_err(|e| InboundError::BadRequest(format!("Store error: {e}")))?;

        self.store
            .update_link_status(link.id, LinkStatus::Active)
            .await
            .map_err(|e| InboundError::BadRequest(format!("Store error: {e}")))?;

        info!(
            recipient_tenant = %recipient_tenant_id,
            sender_did = %msg.collective_did,
            link_id = %link.id,
            "link accept processed, link now active"
        );

        Ok(())
    }

    /// Handle an inbound LINK_REJECT message.
    ///
    /// Finds the corresponding outgoing pending link and marks it rejected.
    pub async fn handle_link_reject(
        &self,
        recipient_tenant_id: TenantId,
        msg: LinkRejectMessage,
    ) -> Result<(), InboundError> {
        validate_did(&msg.collective_did)?;
        if !is_fresh(&msg.timestamp) {
            return Err(InboundError::BadRequest("Message timestamp too old or too new".into()));
        }

        let link = self
            .store
            .find_pending_outgoing_link(recipient_tenant_id, &msg.collective_did)
            .await
            .map_err(|e| InboundError::BadRequest(format!("Store error: {e}")))?
            .ok_or_else(|| {
                InboundError::NotFound(format!(
                    "No pending outgoing link with {}",
                    msg.collective_did
                ))
            })?;

        self.store
            .update_link_status(link.id, LinkStatus::Rejected)
            .await
            .map_err(|e| InboundError::BadRequest(format!("Store error: {e}")))?;

        info!(
            recipient_tenant = %recipient_tenant_id,
            sender_did = %msg.collective_did,
            link_id = %link.id,
            reason = ?msg.reason,
            "link reject processed"
        );

        Ok(())
    }

    /// Handle an inbound LINK_REVOKE message.
    ///
    /// Finds the active link with the peer and revokes it.
    pub async fn handle_link_revoke(
        &self,
        recipient_tenant_id: TenantId,
        msg: LinkRevokeMessage,
    ) -> Result<(), InboundError> {
        if !is_fresh(&msg.timestamp) {
            return Err(InboundError::BadRequest("Message timestamp too old or too new".into()));
        }

        let link = self
            .store
            .find_active_link(recipient_tenant_id, &msg.collective_did)
            .await
            .map_err(|e| InboundError::BadRequest(format!("Store error: {e}")))?
            .ok_or_else(|| {
                InboundError::NotFound(format!(
                    "No active link with {}",
                    msg.collective_did
                ))
            })?;

        // Revoke the link.
        self.store
            .update_link_status(link.id, LinkStatus::Revoked)
            .await
            .map_err(|e| InboundError::BadRequest(format!("Store error: {e}")))?;

        // Tear down any sessions for this link.
        let sessions = self
            .store
            .get_sessions_for_link(link.id)
            .await
            .map_err(|e| InboundError::BadRequest(format!("Store error: {e}")))?;
        for session in sessions {
            self.store
                .delete_session(session.id)
                .await
                .map_err(|e| InboundError::BadRequest(format!("Store error: {e}")))?;
        }

        info!(
            recipient_tenant = %recipient_tenant_id,
            sender_did = %msg.collective_did,
            link_id = %link.id,
            "link revoked by remote peer"
        );

        Ok(())
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::federation_store_memory::FederationMemoryStore;
    use crate::handshake::HandshakeCallbacks;
    use crate::protocol::{Capability, FederationType, RouteAnnouncement};
    use async_trait::async_trait;
    use coord_core::types::{BrokerSession, SessionId};
    use coord_core::CoordError;

    /// Mock callbacks for testing: signs "mock-sig", verifies true, allows all.
    struct MockCallbacks;

    #[async_trait]
    impl HandshakeCallbacks for MockCallbacks {
        async fn sign(&self, _payload: &str) -> Result<String, CoordError> {
            Ok("mock-sig".to_string())
        }

        async fn verify_signature(
            &self,
            _did: &str,
            _payload: &str,
            _signature: &str,
        ) -> Result<bool, CoordError> {
            Ok(true)
        }

        async fn evaluate_policy(
            &self,
            _remote_did: &str,
            _federation_type: &FederationType,
        ) -> Result<bool, CoordError> {
            Ok(true)
        }

        fn get_local_routes(&self) -> Vec<RouteAnnouncement> {
            vec![]
        }
    }

    fn test_config() -> BrokerConfig {
        BrokerConfig {
            tick_interval: Duration::from_secs(1),
            keepalive_stale: Duration::from_secs(90),
            local_capabilities: vec![Capability::RouteExchange],
            public_url: "https://test.example.com".to_string(),
        }
    }

    fn make_active_link(tenant_id: TenantId, peer_did: &str) -> FederationLink {
        let now = Utc::now();
        FederationLink {
            id: LinkId::generate(),
            local_tenant_id: tenant_id,
            peer_did: peer_did.to_string(),
            peer_broker_url: Some("https://peer.example.com".to_string()),
            peer_name: Some("Test Peer".to_string()),
            direction: LinkDirection::Incoming,
            status: LinkStatus::Active,
            local_cidrs: vec!["10.0.0.0/24".to_string()],
            peer_cidrs: vec!["10.1.0.0/24".to_string()],
            protocol_version: Some("1.0.0".to_string()),
            message: None,
            signed_request: None,
            created_at: now,
            updated_at: now,
        }
    }

    fn make_session_for_link(link: &FederationLink) -> BrokerSession {
        let now = Utc::now();
        BrokerSession {
            id: SessionId::generate(),
            federation_link_id: link.id,
            local_tenant_id: link.local_tenant_id,
            peer_did: link.peer_did.clone(),
            status: BrokerSessionStatus::Established,
            cfp_session_id: Some("cfp-test-sess".to_string()),
            remote_endpoint: link.peer_broker_url.clone(),
            protocol_version: link.protocol_version.clone(),
            exported_routes: link.local_cidrs.clone(),
            imported_routes: link.peer_cidrs.clone(),
            last_keepalive: Some(now),
            created_at: now,
            updated_at: now,
        }
    }

    #[tokio::test]
    async fn handle_hello_returns_challenge() {
        let store = Arc::new(FederationMemoryStore::new());
        let tenant_id = TenantId::generate();
        let peer_did = "did:web:peer.example.com:collective:test";
        let link = make_active_link(tenant_id, peer_did);
        store.create_link(link).await.unwrap();

        let handler = InboundHandler::new(store, test_config());

        let hello = HelloMessage {
            collective_did: peer_did.to_string(),
            federation_type: FederationType::Peer,
            offered_cidrs: vec!["10.1.0.0/24".to_string()],
            capabilities: vec![Capability::RouteExchange],
            protocol_version: CFP_VERSION.to_string(),
            mesh_id: None,
            signature: "sig".to_string(),
            timestamp: Utc::now().to_rfc3339(),
        };

        let challenge = handler
            .handle_hello(
                tenant_id,
                "did:web:local.example.com:collective:me",
                hello,
                &MockCallbacks,
            )
            .await
            .unwrap();

        assert!(!challenge.nonce.is_empty());
        assert_eq!(challenge.collective_did, "did:web:local.example.com:collective:me");
    }

    #[tokio::test]
    async fn handle_hello_then_commit_returns_established() {
        let store = Arc::new(FederationMemoryStore::new());
        let tenant_id = TenantId::generate();
        let peer_did = "did:web:peer.example.com:collective:test";
        let link = make_active_link(tenant_id, peer_did);
        store.create_link(link.clone()).await.unwrap();

        // Also create a connecting session so update_session_established finds it.
        let session = BrokerSession {
            id: SessionId::generate(),
            federation_link_id: link.id,
            local_tenant_id: tenant_id,
            peer_did: peer_did.to_string(),
            status: BrokerSessionStatus::Connecting,
            cfp_session_id: None,
            remote_endpoint: None,
            protocol_version: None,
            exported_routes: vec![],
            imported_routes: vec![],
            last_keepalive: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        store.create_session_if_missing(session).await.unwrap();

        let handler = InboundHandler::new(store.clone(), test_config());
        let local_did = "did:web:local.example.com:collective:me";

        // Phase 1: HELLO.
        let hello = HelloMessage {
            collective_did: peer_did.to_string(),
            federation_type: FederationType::Peer,
            offered_cidrs: vec!["10.1.0.0/24".to_string()],
            capabilities: vec![Capability::RouteExchange],
            protocol_version: CFP_VERSION.to_string(),
            mesh_id: None,
            signature: "sig".to_string(),
            timestamp: Utc::now().to_rfc3339(),
        };

        let challenge = handler
            .handle_hello(tenant_id, local_did, hello, &MockCallbacks)
            .await
            .unwrap();

        // Phase 2: COMMIT.
        let commit = CommitMessage {
            collective_did: peer_did.to_string(),
            challenge_nonce: challenge.nonce.clone(),
            challenge_signature: "mock-sig".to_string(),
            initial_routes: vec![],
            signature: "sig".to_string(),
            timestamp: Utc::now().to_rfc3339(),
        };

        let established = handler
            .handle_commit(tenant_id, commit, &MockCallbacks)
            .await
            .unwrap();

        assert!(!established.session_id.is_empty());
        assert_eq!(established.collective_did, local_did);

        // Session should now be established in the store.
        let sessions = store.list_sessions().await.unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].status, BrokerSessionStatus::Established);
    }

    #[tokio::test]
    async fn handle_keepalive_acks() {
        let store = Arc::new(FederationMemoryStore::new());
        let tenant_id = TenantId::generate();
        let peer_did = "did:web:peer.example.com:collective:test";
        let link = make_active_link(tenant_id, peer_did);
        store.create_link(link.clone()).await.unwrap();

        let session = make_session_for_link(&link);
        store.create_session_if_missing(session.clone()).await.unwrap();

        let handler = InboundHandler::new(store, test_config());

        let keepalive = KeepaliveMessage {
            session_id: "cfp-test-sess".to_string(),
            sequence_number: 42,
            timestamp: Utc::now().to_rfc3339(),
            signature: None,
        };

        let ack = handler
            .handle_keepalive(tenant_id, keepalive)
            .await
            .unwrap();

        assert_eq!(ack.session_id, "cfp-test-sess");
        assert_eq!(ack.sequence_number, 42);
    }

    #[tokio::test]
    async fn handle_revoke_tears_down_session() {
        let store = Arc::new(FederationMemoryStore::new());
        let tenant_id = TenantId::generate();
        let peer_did = "did:web:peer.example.com:collective:test";
        let link = make_active_link(tenant_id, peer_did);
        store.create_link(link.clone()).await.unwrap();

        let session = make_session_for_link(&link);
        store.create_session_if_missing(session.clone()).await.unwrap();

        let handler = InboundHandler::new(store.clone(), test_config());

        let revoke = RevokeMessage {
            session_id: "cfp-test-sess".to_string(),
            reason: Some("maintenance".to_string()),
            permanent: false,
            signature: "sig".to_string(),
            timestamp: Utc::now().to_rfc3339(),
        };

        handler.handle_revoke(tenant_id, revoke).await.unwrap();

        let sessions = store.list_sessions().await.unwrap();
        assert!(sessions.is_empty());
    }

    #[tokio::test]
    async fn handle_link_request_creates_pending_link() {
        let store = Arc::new(FederationMemoryStore::new());
        let tenant_id = TenantId::generate();

        let handler = InboundHandler::new(store.clone(), test_config());

        let msg = LinkRequestMessage {
            message_id: "msg-1".to_string(),
            collective_did: "did:web:requester.example.com:collective:test".to_string(),
            broker_url: "https://requester.example.com".to_string(),
            collective_name: "Requester Collective".to_string(),
            federation_type: FederationType::Peer,
            offered_cidrs: vec!["10.2.0.0/24".to_string()],
            capabilities: vec![Capability::RouteExchange],
            message: Some("Let's federate!".to_string()),
            signature: "sig".to_string(),
            timestamp: Utc::now().to_rfc3339(),
        };

        handler
            .handle_link_request(tenant_id, msg)
            .await
            .unwrap();

        // Should have one pending incoming link.
        let count = store.count_pending_incoming(tenant_id).await.unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn handle_link_request_rejects_duplicate() {
        let store = Arc::new(FederationMemoryStore::new());
        let tenant_id = TenantId::generate();
        let peer_did = "did:web:requester.example.com:collective:test";

        // Create an existing active link.
        let link = make_active_link(tenant_id, peer_did);
        store.create_link(link).await.unwrap();

        let handler = InboundHandler::new(store, test_config());

        let msg = LinkRequestMessage {
            message_id: "msg-1".to_string(),
            collective_did: peer_did.to_string(),
            broker_url: "https://requester.example.com".to_string(),
            collective_name: "Requester".to_string(),
            federation_type: FederationType::Peer,
            offered_cidrs: vec![],
            capabilities: vec![],
            message: None,
            signature: "sig".to_string(),
            timestamp: Utc::now().to_rfc3339(),
        };

        let result = handler.handle_link_request(tenant_id, msg).await;
        assert!(result.is_err());
        match result.unwrap_err() {
            InboundError::Conflict(_) => {}
            other => panic!("expected Conflict, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn handle_link_revoke_revokes_link_and_sessions() {
        let store = Arc::new(FederationMemoryStore::new());
        let tenant_id = TenantId::generate();
        let peer_did = "did:web:peer.example.com:collective:test";
        let link = make_active_link(tenant_id, peer_did);
        store.create_link(link.clone()).await.unwrap();

        let session = make_session_for_link(&link);
        store.create_session_if_missing(session).await.unwrap();

        let handler = InboundHandler::new(store.clone(), test_config());

        let msg = LinkRevokeMessage {
            message_id: "msg-revoke".to_string(),
            collective_did: peer_did.to_string(),
            reason: Some("done".to_string()),
            permanent: true,
            signature: "sig".to_string(),
            timestamp: Utc::now().to_rfc3339(),
        };

        handler.handle_link_revoke(tenant_id, msg).await.unwrap();

        // Link should be revoked.
        let link_after = store.get_link(link.id).await.unwrap().unwrap();
        assert_eq!(link_after.status, LinkStatus::Revoked);

        // Sessions should be gone.
        let sessions = store.list_sessions().await.unwrap();
        assert!(sessions.is_empty());
    }

    #[tokio::test]
    async fn handle_hello_rejects_stale_timestamp() {
        let store = Arc::new(FederationMemoryStore::new());
        let tenant_id = TenantId::generate();
        let handler = InboundHandler::new(store, test_config());

        let hello = HelloMessage {
            collective_did: "did:web:peer".to_string(),
            federation_type: FederationType::Peer,
            offered_cidrs: vec![],
            capabilities: vec![],
            protocol_version: CFP_VERSION.to_string(),
            mesh_id: None,
            signature: "sig".to_string(),
            timestamp: (Utc::now() - chrono::Duration::seconds(600)).to_rfc3339(),
        };

        let result = handler
            .handle_hello(tenant_id, "did:web:local", hello, &MockCallbacks)
            .await;
        assert!(result.is_err());
        match result.unwrap_err() {
            InboundError::BadRequest(msg) => {
                assert!(msg.contains("timestamp"));
            }
            other => panic!("expected BadRequest, got {:?}", other),
        }
    }
}
