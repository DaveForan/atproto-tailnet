//! CFP 4-phase handshake state machine (ADR-0014).
//!
//! Ported from `src/federation/handshake.ts` (365 lines).
//! Async state machine with injected callbacks — each function takes owned state
//! and returns the next state plus any outbound message.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use rand::Rng;

use coord_core::CoordError;

use crate::protocol::{
    Capability, ChallengeMessage, CommitMessage, EstablishedMessage, FederationType,
    HandshakePhase, HelloMessage, RouteAnnouncement, CFP_VERSION,
    CHALLENGE_EXPIRY_DEFAULT_SECONDS, DEFAULT_KEEPALIVE_SECONDS, KEEPALIVE_RANGE,
};

// ── Types ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct HandshakeState {
    pub phase: HandshakePhase,
    pub local_did: String,
    pub remote_did: Option<String>,
    pub session_id: Option<String>,
    pub negotiated_version: Option<String>,
    pub negotiated_type: Option<FederationType>,
    pub negotiated_cidrs: Option<Vec<String>>,
    pub negotiated_capabilities: Option<Vec<Capability>>,
    pub keepalive_seconds: Option<u32>,
    pub challenge_nonce: Option<String>,
    pub challenge_expires_at: Option<DateTime<Utc>>,
    pub error: Option<String>,
    pub started_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

// ── Callbacks trait ────────────────────────────────────────────────────────────

#[async_trait]
pub trait HandshakeCallbacks: Send + Sync {
    /// Sign a payload and return the signature string.
    async fn sign(&self, payload: &str) -> Result<String, CoordError>;

    /// Verify that `signature` is a valid signature by `did` over `payload`.
    async fn verify_signature(
        &self,
        did: &str,
        payload: &str,
        signature: &str,
    ) -> Result<bool, CoordError>;

    /// Evaluate whether federation with `remote_did` of the given type is allowed.
    async fn evaluate_policy(
        &self,
        remote_did: &str,
        federation_type: &FederationType,
    ) -> Result<bool, CoordError>;

    /// Return the local route announcements to include in COMMIT/ESTABLISHED.
    fn get_local_routes(&self) -> Vec<RouteAnnouncement>;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/// Negotiate the minimum of two semver version strings.
fn negotiate_version(remote: &str, local: &str) -> String {
    let r_parts: Vec<u32> = remote.split('.').map(|s| s.parse().unwrap_or(0)).collect();
    let l_parts: Vec<u32> = local.split('.').map(|s| s.parse().unwrap_or(0)).collect();

    for i in 0..3 {
        let r = r_parts.get(i).copied().unwrap_or(0);
        let l = l_parts.get(i).copied().unwrap_or(0);
        if r < l {
            return remote.to_string();
        }
        if r > l {
            return local.to_string();
        }
    }
    local.to_string()
}

/// Generate `n` random bytes and return them as a hex string.
fn random_hex(n: usize) -> String {
    let mut buf = vec![0u8; n];
    rand::rng().fill(&mut buf[..]);
    hex::encode(&buf)
}

// ── State machine functions ────────────────────────────────────────────────────

/// Create a new idle handshake state for the given local DID.
pub fn create_handshake(local_did: &str) -> HandshakeState {
    let now = Utc::now();
    HandshakeState {
        phase: HandshakePhase::Idle,
        local_did: local_did.to_string(),
        remote_did: None,
        session_id: None,
        negotiated_version: None,
        negotiated_type: None,
        negotiated_cidrs: None,
        negotiated_capabilities: None,
        keepalive_seconds: None,
        challenge_nonce: None,
        challenge_expires_at: None,
        error: None,
        started_at: now,
        updated_at: now,
    }
}

/// Initiate a HELLO: transitions Idle -> HelloSent and produces a HelloMessage.
pub async fn initiate_hello(
    mut state: HandshakeState,
    remote_did: &str,
    fed_type: FederationType,
    cidrs: Vec<String>,
    capabilities: Vec<Capability>,
    callbacks: &dyn HandshakeCallbacks,
) -> Result<(HandshakeState, HelloMessage), CoordError> {
    let timestamp = Utc::now().to_rfc3339();

    // Build the signing payload (message without signature).
    let payload = serde_json::json!({
        "type": "HELLO",
        "collectiveDid": state.local_did,
        "federationType": fed_type,
        "offeredCidrs": cidrs,
        "capabilities": capabilities,
        "protocolVersion": CFP_VERSION,
        "timestamp": timestamp,
    });
    let signature = callbacks.sign(&payload.to_string()).await?;

    let message = HelloMessage {
        collective_did: state.local_did.clone(),
        federation_type: fed_type.clone(),
        offered_cidrs: cidrs,
        capabilities,
        protocol_version: CFP_VERSION.to_string(),
        mesh_id: None,
        signature,
        timestamp,
    };

    state.phase = HandshakePhase::HelloSent;
    state.remote_did = Some(remote_did.to_string());
    state.negotiated_type = Some(fed_type);
    state.updated_at = Utc::now();

    Ok((state, message))
}

/// Handle an incoming HELLO: verify signature, evaluate policy, compute
/// intersections, generate challenge nonce. Transitions to ChallengeSent.
pub async fn handle_hello(
    mut state: HandshakeState,
    hello: &HelloMessage,
    local_cidrs: &[String],
    local_capabilities: &[Capability],
    callbacks: &dyn HandshakeCallbacks,
) -> Result<(HandshakeState, ChallengeMessage), (HandshakeState, String)> {
    // Build the payload that was signed (message minus signature).
    let mut hello_json = serde_json::to_value(hello).map_err(|e| {
        state.phase = HandshakePhase::Failed;
        (state.clone(), format!("Failed to serialize HELLO for verification: {e}"))
    })?;
    if let Some(obj) = hello_json.as_object_mut() {
        obj.remove("signature");
        // Remove meshId if null (match TS behavior of undefined).
        if obj.get("meshId").is_some_and(|v| v.is_null()) {
            obj.remove("meshId");
        }
    }
    let payload = hello_json.to_string();

    let valid = callbacks
        .verify_signature(&hello.collective_did, &payload, &hello.signature)
        .await
        .unwrap_or(false);
    if !valid {
        state.phase = HandshakePhase::Failed;
        state.error = Some("Invalid HELLO signature".to_string());
        state.updated_at = Utc::now();
        return Err((state, "Invalid HELLO signature".to_string()));
    }

    let policy_ok = callbacks
        .evaluate_policy(&hello.collective_did, &hello.federation_type)
        .await
        .unwrap_or(false);
    if !policy_ok {
        state.phase = HandshakePhase::Failed;
        state.error = Some("Policy denied federation".to_string());
        state.updated_at = Utc::now();
        return Err((state, "Policy denied federation".to_string()));
    }

    let negotiated_version = negotiate_version(&hello.protocol_version, CFP_VERSION);

    // Intersection of CIDRs.
    let accepted_cidrs = if local_cidrs.is_empty() && hello.offered_cidrs.is_empty() {
        vec![]
    } else {
        let offered: std::collections::HashSet<&str> =
            hello.offered_cidrs.iter().map(|s| s.as_str()).collect();
        local_cidrs
            .iter()
            .filter(|c| offered.contains(c.as_str()) || hello.offered_cidrs.is_empty())
            .cloned()
            .collect()
    };

    // Intersection of capabilities.
    let accepted_capabilities: Vec<Capability> = local_capabilities
        .iter()
        .filter(|c| hello.capabilities.contains(c))
        .cloned()
        .collect();

    // Generate 32-byte nonce (hex-encoded).
    let nonce = random_hex(32);

    let expires_at =
        Utc::now() + chrono::Duration::seconds(i64::from(CHALLENGE_EXPIRY_DEFAULT_SECONDS));

    let keepalive = DEFAULT_KEEPALIVE_SECONDS
        .max(*KEEPALIVE_RANGE.start())
        .min(*KEEPALIVE_RANGE.end());

    let timestamp = Utc::now().to_rfc3339();
    let challenge_payload = serde_json::json!({
        "type": "CHALLENGE",
        "collectiveDid": state.local_did,
        "nonce": nonce,
        "expiresAt": expires_at.to_rfc3339(),
        "acceptedType": hello.federation_type,
        "acceptedCidrs": accepted_cidrs,
        "acceptedCapabilities": accepted_capabilities,
        "negotiatedVersion": negotiated_version,
        "negotiatedKeepaliveSeconds": keepalive,
        "timestamp": timestamp,
    });
    let signature = callbacks
        .sign(&challenge_payload.to_string())
        .await
        .map_err(|e| {
            state.phase = HandshakePhase::Failed;
            state.error = Some(format!("Sign error: {e}"));
            state.updated_at = Utc::now();
            (state.clone(), format!("Sign error: {e}"))
        })?;

    let message = ChallengeMessage {
        collective_did: state.local_did.clone(),
        nonce: nonce.clone(),
        expires_at: expires_at.to_rfc3339(),
        accepted_type: hello.federation_type.clone(),
        accepted_cidrs: accepted_cidrs.clone(),
        accepted_capabilities: accepted_capabilities.clone(),
        negotiated_version: negotiated_version.clone(),
        negotiated_keepalive_seconds: keepalive,
        signature,
        timestamp,
    };

    state.phase = HandshakePhase::ChallengeSent;
    state.remote_did = Some(hello.collective_did.clone());
    state.challenge_nonce = Some(nonce);
    state.challenge_expires_at = Some(expires_at);
    state.negotiated_type = Some(hello.federation_type.clone());
    state.negotiated_version = Some(negotiated_version);
    state.negotiated_cidrs = Some(accepted_cidrs);
    state.negotiated_capabilities = Some(accepted_capabilities);
    state.keepalive_seconds = Some(keepalive);
    state.updated_at = Utc::now();

    Ok((state, message))
}

/// Handle an incoming CHALLENGE: verify we are in HelloSent, check expiry,
/// sign the nonce, build COMMIT with local routes. Transitions to CommitSent.
pub async fn handle_challenge(
    mut state: HandshakeState,
    challenge: &ChallengeMessage,
    callbacks: &dyn HandshakeCallbacks,
) -> Result<(HandshakeState, CommitMessage), (HandshakeState, String)> {
    if state.phase != HandshakePhase::HelloSent {
        let err = format!("Unexpected CHALLENGE in phase {:?}", state.phase);
        state.phase = HandshakePhase::Failed;
        state.error = Some("Unexpected CHALLENGE".to_string());
        state.updated_at = Utc::now();
        return Err((state, err));
    }

    // Check expiry.
    if let Ok(expires) = challenge.expires_at.parse::<DateTime<Utc>>() {
        if expires < Utc::now() {
            state.phase = HandshakePhase::Failed;
            state.error = Some("Challenge expired".to_string());
            state.updated_at = Utc::now();
            return Err((state, "Challenge expired".to_string()));
        }
    }

    // Sign the challenge nonce.
    let challenge_signature = callbacks.sign(&challenge.nonce).await.map_err(|e| {
        state.phase = HandshakePhase::Failed;
        state.error = Some(format!("Sign error: {e}"));
        state.updated_at = Utc::now();
        (state.clone(), format!("Sign error: {e}"))
    })?;

    let routes = callbacks.get_local_routes();

    let timestamp = Utc::now().to_rfc3339();
    let commit_payload = serde_json::json!({
        "type": "COMMIT",
        "collectiveDid": state.local_did,
        "challengeNonce": challenge.nonce,
        "initialRoutes": routes,
        "timestamp": timestamp,
    });
    let signature = callbacks
        .sign(&commit_payload.to_string())
        .await
        .map_err(|e| {
            state.phase = HandshakePhase::Failed;
            state.error = Some(format!("Sign error: {e}"));
            state.updated_at = Utc::now();
            (state.clone(), format!("Sign error: {e}"))
        })?;

    let message = CommitMessage {
        collective_did: state.local_did.clone(),
        challenge_nonce: challenge.nonce.clone(),
        challenge_signature,
        initial_routes: routes,
        signature,
        timestamp,
    };

    state.phase = HandshakePhase::CommitSent;
    state.negotiated_version = Some(challenge.negotiated_version.clone());
    state.negotiated_type = Some(challenge.accepted_type.clone());
    state.negotiated_cidrs = Some(challenge.accepted_cidrs.clone());
    state.negotiated_capabilities = Some(challenge.accepted_capabilities.clone());
    state.keepalive_seconds = Some(challenge.negotiated_keepalive_seconds);
    state.updated_at = Utc::now();

    Ok((state, message))
}

/// Handle an incoming COMMIT: verify ChallengeSent phase, check expiry and
/// nonce match, verify nonce signature, generate session ID, build ESTABLISHED.
pub async fn handle_commit(
    mut state: HandshakeState,
    commit: &CommitMessage,
    callbacks: &dyn HandshakeCallbacks,
) -> Result<(HandshakeState, EstablishedMessage), (HandshakeState, String)> {
    if state.phase != HandshakePhase::ChallengeSent {
        let err = format!("Unexpected COMMIT in phase {:?}", state.phase);
        state.phase = HandshakePhase::Failed;
        state.error = Some("Unexpected COMMIT".to_string());
        state.updated_at = Utc::now();
        return Err((state, err));
    }

    // Check challenge expiry.
    if let Some(expires_at) = &state.challenge_expires_at {
        if *expires_at < Utc::now() {
            state.phase = HandshakePhase::Failed;
            state.error = Some("Challenge expired".to_string());
            state.updated_at = Utc::now();
            return Err((state, "Challenge expired before COMMIT received".to_string()));
        }
    }

    // Nonce must match.
    if state.challenge_nonce.as_deref() != Some(&commit.challenge_nonce) {
        state.phase = HandshakePhase::Failed;
        state.error = Some("Nonce mismatch".to_string());
        state.updated_at = Utc::now();
        return Err((state, "Challenge nonce mismatch".to_string()));
    }

    // Verify the nonce signature from the remote peer.
    let nonce_valid = callbacks
        .verify_signature(
            &commit.collective_did,
            &commit.challenge_nonce,
            &commit.challenge_signature,
        )
        .await
        .unwrap_or(false);
    if !nonce_valid {
        state.phase = HandshakePhase::Failed;
        state.error = Some("Invalid nonce signature".to_string());
        state.updated_at = Utc::now();
        return Err((state, "Invalid challenge nonce signature".to_string()));
    }

    // Generate session ID (16 random bytes as hex = 32 hex chars).
    let session_id = random_hex(16);
    let routes = callbacks.get_local_routes();

    let keepalive = state.keepalive_seconds.unwrap_or(DEFAULT_KEEPALIVE_SECONDS);

    let timestamp = Utc::now().to_rfc3339();
    let est_payload = serde_json::json!({
        "type": "ESTABLISHED",
        "sessionId": session_id,
        "collectiveDid": state.local_did,
        "initialRoutes": routes,
        "keepaliveIntervalSeconds": keepalive,
        "timestamp": timestamp,
    });
    let signature = callbacks
        .sign(&est_payload.to_string())
        .await
        .map_err(|e| {
            state.phase = HandshakePhase::Failed;
            state.error = Some(format!("Sign error: {e}"));
            state.updated_at = Utc::now();
            (state.clone(), format!("Sign error: {e}"))
        })?;

    let message = EstablishedMessage {
        session_id: session_id.clone(),
        collective_did: state.local_did.clone(),
        initial_routes: routes,
        keepalive_interval_seconds: keepalive,
        signature,
        timestamp,
    };

    state.phase = HandshakePhase::Established;
    state.session_id = Some(session_id);
    state.updated_at = Utc::now();

    Ok((state, message))
}

/// Handle an incoming ESTABLISHED: verify CommitSent phase, transition to Established.
pub fn handle_established(
    mut state: HandshakeState,
    established: &EstablishedMessage,
) -> HandshakeState {
    if state.phase != HandshakePhase::CommitSent {
        state.phase = HandshakePhase::Failed;
        state.error = Some("Unexpected ESTABLISHED".to_string());
        state.updated_at = Utc::now();
        return state;
    }

    state.phase = HandshakePhase::Established;
    state.session_id = Some(established.session_id.clone());
    state.keepalive_seconds = Some(established.keepalive_interval_seconds);
    state.updated_at = Utc::now();
    state
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Mock callbacks: sign returns "mock-sig", verify always returns true,
    /// policy always allows, no local routes.
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
            vec![RouteAnnouncement {
                prefix: "10.0.0.0/24".to_string(),
                origin_did: "did:web:local".to_string(),
                path_vector: vec!["did:web:local".to_string()],
                community_tags: vec![],
                preference: 100,
                origin_signature: "osig".to_string(),
            }]
        }
    }

    #[test]
    fn negotiate_version_picks_minimum() {
        assert_eq!(negotiate_version("1.0.0", "1.0.0"), "1.0.0");
        assert_eq!(negotiate_version("1.1.0", "1.0.0"), "1.0.0");
        assert_eq!(negotiate_version("1.0.0", "1.1.0"), "1.0.0");
        assert_eq!(negotiate_version("2.0.0", "1.5.3"), "1.5.3");
        assert_eq!(negotiate_version("0.9.0", "1.0.0"), "0.9.0");
    }

    #[tokio::test]
    async fn full_four_phase_handshake() {
        let cb = MockCallbacks;

        // --- Phase 1: HELLO ---
        let initiator_state = create_handshake("did:web:initiator");
        let (initiator_state, hello) = initiate_hello(
            initiator_state,
            "did:web:responder",
            FederationType::Peer,
            vec!["10.0.0.0/24".into()],
            vec![Capability::RouteExchange],
            &cb,
        )
        .await
        .unwrap();

        assert_eq!(initiator_state.phase, HandshakePhase::HelloSent);
        assert_eq!(hello.collective_did, "did:web:initiator");
        assert_eq!(hello.federation_type, FederationType::Peer);

        // --- Phase 2: CHALLENGE ---
        let responder_state = create_handshake("did:web:responder");
        let (responder_state, challenge) = handle_hello(
            responder_state,
            &hello,
            &["10.0.0.0/24".into()],
            &[Capability::RouteExchange],
            &cb,
        )
        .await
        .unwrap();

        assert_eq!(responder_state.phase, HandshakePhase::ChallengeSent);
        assert_eq!(
            responder_state.remote_did.as_deref(),
            Some("did:web:initiator")
        );
        assert!(responder_state.challenge_nonce.is_some());
        assert_eq!(
            responder_state.negotiated_cidrs.as_deref(),
            Some(&["10.0.0.0/24".to_string()][..])
        );

        // --- Phase 3: COMMIT ---
        let (initiator_state, commit) =
            handle_challenge(initiator_state, &challenge, &cb).await.unwrap();

        assert_eq!(initiator_state.phase, HandshakePhase::CommitSent);
        assert_eq!(commit.collective_did, "did:web:initiator");
        assert_eq!(commit.challenge_nonce, challenge.nonce);
        assert!(!commit.initial_routes.is_empty());

        // --- Phase 4: ESTABLISHED ---
        let (responder_state, established) =
            handle_commit(responder_state, &commit, &cb).await.unwrap();

        assert_eq!(responder_state.phase, HandshakePhase::Established);
        assert!(responder_state.session_id.is_some());
        assert!(!established.session_id.is_empty());
        assert!(!established.initial_routes.is_empty());

        // --- Initiator receives ESTABLISHED ---
        let initiator_state = handle_established(initiator_state, &established);
        assert_eq!(initiator_state.phase, HandshakePhase::Established);
        assert_eq!(initiator_state.session_id, Some(established.session_id));
    }

    #[tokio::test]
    async fn handle_challenge_rejects_wrong_phase() {
        let cb = MockCallbacks;
        let state = create_handshake("did:web:local");
        // State is Idle, not HelloSent.
        let challenge = ChallengeMessage {
            collective_did: "did:web:remote".into(),
            nonce: "abc".into(),
            expires_at: (Utc::now() + chrono::Duration::seconds(120)).to_rfc3339(),
            accepted_type: FederationType::Peer,
            accepted_cidrs: vec![],
            accepted_capabilities: vec![],
            negotiated_version: "1.0.0".into(),
            negotiated_keepalive_seconds: 60,
            signature: "sig".into(),
            timestamp: Utc::now().to_rfc3339(),
        };

        let result = handle_challenge(state, &challenge, &cb).await;
        assert!(result.is_err());
        let (failed_state, err_msg) = result.unwrap_err();
        assert_eq!(failed_state.phase, HandshakePhase::Failed);
        assert!(err_msg.contains("Unexpected CHALLENGE"));
    }

    #[tokio::test]
    async fn handle_commit_rejects_nonce_mismatch() {
        let cb = MockCallbacks;
        let mut state = create_handshake("did:web:local");
        state.phase = HandshakePhase::ChallengeSent;
        state.challenge_nonce = Some("correct-nonce".to_string());
        state.challenge_expires_at =
            Some(Utc::now() + chrono::Duration::seconds(120));

        let commit = CommitMessage {
            collective_did: "did:web:remote".into(),
            challenge_nonce: "wrong-nonce".into(),
            challenge_signature: "sig".into(),
            initial_routes: vec![],
            signature: "sig".into(),
            timestamp: Utc::now().to_rfc3339(),
        };

        let result = handle_commit(state, &commit, &cb).await;
        assert!(result.is_err());
        let (_, err_msg) = result.unwrap_err();
        assert!(err_msg.contains("nonce mismatch"));
    }

    #[test]
    fn handle_established_rejects_wrong_phase() {
        let state = create_handshake("did:web:local");
        // State is Idle, not CommitSent.
        let established = EstablishedMessage {
            session_id: "sess-1".into(),
            collective_did: "did:web:remote".into(),
            initial_routes: vec![],
            keepalive_interval_seconds: 60,
            signature: "sig".into(),
            timestamp: Utc::now().to_rfc3339(),
        };

        let state = handle_established(state, &established);
        assert_eq!(state.phase, HandshakePhase::Failed);
    }

    #[tokio::test]
    async fn handle_hello_policy_rejection() {
        /// Callbacks that deny policy.
        struct DenyCallbacks;

        #[async_trait]
        impl HandshakeCallbacks for DenyCallbacks {
            async fn sign(&self, _payload: &str) -> Result<String, CoordError> {
                Ok("sig".into())
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
                Ok(false) // deny
            }
            fn get_local_routes(&self) -> Vec<RouteAnnouncement> {
                vec![]
            }
        }

        let state = create_handshake("did:web:local");
        let hello = HelloMessage {
            collective_did: "did:web:remote".into(),
            federation_type: FederationType::Peer,
            offered_cidrs: vec!["10.0.0.0/24".into()],
            capabilities: vec![Capability::RouteExchange],
            protocol_version: CFP_VERSION.into(),
            mesh_id: None,
            signature: "sig".into(),
            timestamp: Utc::now().to_rfc3339(),
        };

        let result = handle_hello(
            state,
            &hello,
            &["10.0.0.0/24".into()],
            &[Capability::RouteExchange],
            &DenyCallbacks,
        )
        .await;
        assert!(result.is_err());
        let (failed_state, err_msg) = result.unwrap_err();
        assert_eq!(failed_state.phase, HandshakePhase::Failed);
        assert!(err_msg.contains("Policy denied"));
    }
}
