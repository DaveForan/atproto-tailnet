//! CFP 4-phase handshake state machine (ADR-0014).
//! Each function takes owned state and returns the next state plus any outbound message.

use async_trait::async_trait;
use coord_core::clock::{self, Duration, OffsetDateTime};
use rand::Rng;

use coord_core::CoordError;

use crate::auth::{challenge_response_payload, is_valid_challenge_nonce, message_signing_payload};
use crate::protocol::{
    Capability, ChallengeMessage, CommitMessage, EstablishedMessage, FederationType,
    HandshakePhase, HelloMessage, RouteAnnouncement, CFP_VERSION,
    CHALLENGE_EXPIRY_DEFAULT_SECONDS, DEFAULT_KEEPALIVE_SECONDS, KEEPALIVE_RANGE,
};


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
    pub challenge_expires_at: Option<OffsetDateTime>,
    pub error: Option<String>,
    pub started_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}


#[async_trait]
pub trait HandshakeCallbacks: Send + Sync {
    async fn sign(&self, payload: &str) -> Result<String, CoordError>;

    /// Verifies that `signature` is a valid signature by `did` over `payload`.
    async fn verify_signature(
        &self,
        did: &str,
        payload: &str,
        signature: &str,
    ) -> Result<bool, CoordError>;

    /// Decides whether federation with `remote_did` of this type is allowed.
    async fn evaluate_policy(
        &self,
        remote_did: &str,
        federation_type: &FederationType,
    ) -> Result<bool, CoordError>;

    /// Returns the local route announcements for COMMIT/ESTABLISHED.
    fn get_local_routes(&self) -> Vec<RouteAnnouncement>;
}


/// Returns the lower of two semver version strings.
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

/// Marks `state` failed with `error` and returns the state machine's `Err` pair.
fn fail(mut state: HandshakeState, error: &str) -> (HandshakeState, String) {
    state.phase = HandshakePhase::Failed;
    state.error = Some(error.to_string());
    state.updated_at = clock::now();
    (state, error.to_string())
}

/// Verifies `message`'s detached signature by `did` over [`message_signing_payload`], the bytes the sender signed.
async fn verify_signed<T: crate::protocol::CfpSigned>(
    did: &str,
    message: &T,
    signature: &str,
    callbacks: &dyn HandshakeCallbacks,
) -> bool {
    if signature.is_empty() {
        return false;
    }
    let Ok(payload) = message_signing_payload(message) else {
        return false;
    };
    callbacks
        .verify_signature(did, &payload, signature)
        .await
        .unwrap_or(false)
}

/// Returns `n` random bytes as a hex string.
fn random_hex(n: usize) -> String {
    let mut buf = vec![0u8; n];
    rand::rng().fill(&mut buf[..]);
    hex::encode(&buf)
}


pub fn create_handshake(local_did: &str) -> HandshakeState {
    let now = clock::now();
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

/// Starts a HELLO: moves Idle to HelloSent and returns the HelloMessage.
pub async fn initiate_hello(
    mut state: HandshakeState,
    remote_did: &str,
    fed_type: FederationType,
    cidrs: Vec<String>,
    capabilities: Vec<Capability>,
    callbacks: &dyn HandshakeCallbacks,
) -> Result<(HandshakeState, HelloMessage), CoordError> {
    let timestamp = clock::to_rfc3339(clock::now());

    let mut message = HelloMessage {
        collective_did: state.local_did.clone(),
        federation_type: fed_type.clone(),
        offered_cidrs: cidrs,
        capabilities,
        protocol_version: CFP_VERSION.to_string(),
        mesh_id: None,
        signature: String::new(),
        timestamp,
    };
    // Sign exactly what the receiver rebuilds (see `message_signing_payload`).
    message.signature = callbacks.sign(&message_signing_payload(&message)?).await?;

    state.phase = HandshakePhase::HelloSent;
    state.remote_did = Some(remote_did.to_string());
    state.negotiated_type = Some(fed_type);
    state.updated_at = clock::now();

    Ok((state, message))
}

/// Handles a HELLO: verifies it, checks policy, intersects CIDRs and capabilities, and issues a challenge.
/// Moves to ChallengeSent.
pub async fn handle_hello(
    mut state: HandshakeState,
    hello: &HelloMessage,
    local_cidrs: &[String],
    local_capabilities: &[Capability],
    callbacks: &dyn HandshakeCallbacks,
) -> Result<(HandshakeState, ChallengeMessage), (HandshakeState, String)> {
    if !verify_signed(&hello.collective_did, hello, &hello.signature, callbacks).await {
        return Err(fail(state, "Invalid HELLO signature"));
    }

    let policy_ok = callbacks
        .evaluate_policy(&hello.collective_did, &hello.federation_type)
        .await
        .unwrap_or(false);
    if !policy_ok {
        state.phase = HandshakePhase::Failed;
        state.error = Some("Policy denied federation".to_string());
        state.updated_at = clock::now();
        return Err((state, "Policy denied federation".to_string()));
    }

    let negotiated_version = negotiate_version(&hello.protocol_version, CFP_VERSION);

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

    let accepted_capabilities: Vec<Capability> = local_capabilities
        .iter()
        .filter(|c| hello.capabilities.contains(c))
        .cloned()
        .collect();

    let nonce = random_hex(32);

    let expires_at =
        clock::now() + Duration::seconds(i64::from(CHALLENGE_EXPIRY_DEFAULT_SECONDS));

    let keepalive = DEFAULT_KEEPALIVE_SECONDS
        .max(*KEEPALIVE_RANGE.start())
        .min(*KEEPALIVE_RANGE.end());

    let timestamp = clock::to_rfc3339(clock::now());
    let mut message = ChallengeMessage {
        collective_did: state.local_did.clone(),
        nonce: nonce.clone(),
        expires_at: clock::to_rfc3339(expires_at),
        accepted_type: hello.federation_type.clone(),
        accepted_cidrs: accepted_cidrs.clone(),
        accepted_capabilities: accepted_capabilities.clone(),
        negotiated_version: negotiated_version.clone(),
        negotiated_keepalive_seconds: keepalive,
        signature: String::new(),
        timestamp,
    };
    let signed = match message_signing_payload(&message) {
        Ok(payload) => callbacks.sign(&payload).await,
        Err(e) => Err(e),
    };
    message.signature = match signed {
        Ok(sig) => sig,
        Err(e) => return Err(fail(state, &format!("Sign error: {e}"))),
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
    state.updated_at = clock::now();

    Ok((state, message))
}

/// Handles a CHALLENGE in HelloSent: checks expiry, signs the nonce, and builds COMMIT.
/// Moves to CommitSent.
pub async fn handle_challenge(
    mut state: HandshakeState,
    challenge: &ChallengeMessage,
    callbacks: &dyn HandshakeCallbacks,
) -> Result<(HandshakeState, CommitMessage), (HandshakeState, String)> {
    if state.phase != HandshakePhase::HelloSent {
        let err = format!("Unexpected CHALLENGE in phase {:?}", state.phase);
        state.phase = HandshakePhase::Failed;
        state.error = Some("Unexpected CHALLENGE".to_string());
        state.updated_at = clock::now();
        return Err((state, err));
    }

    // The CHALLENGE must come from, and be signed by, the collective we said HELLO to.
    let Some(remote_did) = state.remote_did.clone() else {
        return Err(fail(state, "No remote DID for CHALLENGE"));
    };
    if challenge.collective_did != remote_did {
        return Err(fail(state, "CHALLENGE from unexpected sender"));
    }
    if !verify_signed(&remote_did, challenge, &challenge.signature, callbacks).await {
        return Err(fail(state, "Invalid CHALLENGE signature"));
    }

    // An unparseable expiry counts as expired.
    match clock::parse_rfc3339(&challenge.expires_at) {
        Some(expires) if expires >= clock::now() => {}
        _ => return Err(fail(state, "Challenge expired")),
    }

    if !is_valid_challenge_nonce(&challenge.nonce) {
        return Err(fail(state, "Malformed challenge nonce"));
    }

    // Sign a typed, audience-bound wrapper — never the peer-chosen nonce verbatim.
    let response = challenge_response_payload(&challenge.nonce, &state.local_did, &remote_did);
    let challenge_signature = match callbacks.sign(&response).await {
        Ok(sig) => sig,
        Err(e) => return Err(fail(state, &format!("Sign error: {e}"))),
    };

    let routes = callbacks.get_local_routes();

    let timestamp = clock::to_rfc3339(clock::now());
    let mut message = CommitMessage {
        collective_did: state.local_did.clone(),
        challenge_nonce: challenge.nonce.clone(),
        challenge_signature,
        initial_routes: routes,
        signature: String::new(),
        timestamp,
    };
    let signed = match message_signing_payload(&message) {
        Ok(payload) => callbacks.sign(&payload).await,
        Err(e) => Err(e),
    };
    message.signature = match signed {
        Ok(sig) => sig,
        Err(e) => return Err(fail(state, &format!("Sign error: {e}"))),
    };

    state.phase = HandshakePhase::CommitSent;
    state.negotiated_version = Some(challenge.negotiated_version.clone());
    state.negotiated_type = Some(challenge.accepted_type.clone());
    state.negotiated_cidrs = Some(challenge.accepted_cidrs.clone());
    state.negotiated_capabilities = Some(challenge.accepted_capabilities.clone());
    state.keepalive_seconds = Some(challenge.negotiated_keepalive_seconds);
    state.updated_at = clock::now();

    Ok((state, message))
}

/// Handles a COMMIT in ChallengeSent: checks expiry, nonce, and signatures, then builds ESTABLISHED.
pub async fn handle_commit(
    mut state: HandshakeState,
    commit: &CommitMessage,
    callbacks: &dyn HandshakeCallbacks,
) -> Result<(HandshakeState, EstablishedMessage), (HandshakeState, String)> {
    if state.phase != HandshakePhase::ChallengeSent {
        let err = format!("Unexpected COMMIT in phase {:?}", state.phase);
        state.phase = HandshakePhase::Failed;
        state.error = Some("Unexpected COMMIT".to_string());
        state.updated_at = clock::now();
        return Err((state, err));
    }

    if let Some(expires_at) = &state.challenge_expires_at
        && *expires_at < clock::now() {
            state.phase = HandshakePhase::Failed;
            state.error = Some("Challenge expired".to_string());
            state.updated_at = clock::now();
            return Err((state, "Challenge expired before COMMIT received".to_string()));
        }

    // Only the collective we challenged may answer.
    let Some(remote_did) = state.remote_did.clone() else {
        return Err(fail(state, "No remote DID for COMMIT"));
    };
    if commit.collective_did != remote_did {
        return Err(fail(state, "COMMIT from unexpected sender"));
    }

    if !is_valid_challenge_nonce(&commit.challenge_nonce)
        || state.challenge_nonce.as_deref() != Some(&commit.challenge_nonce)
    {
        return Err(fail(state, "Challenge nonce mismatch"));
    }

    // The peer must sign the COMMIT itself: routes, timestamp, and challenge response.
    if !verify_signed(&remote_did, commit, &commit.signature, callbacks).await {
        return Err(fail(state, "Invalid COMMIT signature"));
    }

    // The challenge response must be the typed wrapper addressed to us.
    let response =
        challenge_response_payload(&commit.challenge_nonce, &remote_did, &state.local_did);
    let nonce_valid = !commit.challenge_signature.is_empty()
        && callbacks
            .verify_signature(&remote_did, &response, &commit.challenge_signature)
            .await
            .unwrap_or(false);
    if !nonce_valid {
        return Err(fail(state, "Invalid challenge nonce signature"));
    }

    let session_id = random_hex(16);
    let routes = callbacks.get_local_routes();

    let keepalive = state.keepalive_seconds.unwrap_or(DEFAULT_KEEPALIVE_SECONDS);

    let timestamp = clock::to_rfc3339(clock::now());
    let mut message = EstablishedMessage {
        session_id: session_id.clone(),
        collective_did: state.local_did.clone(),
        initial_routes: routes,
        keepalive_interval_seconds: keepalive,
        signature: String::new(),
        timestamp,
    };
    let signed = match message_signing_payload(&message) {
        Ok(payload) => callbacks.sign(&payload).await,
        Err(e) => Err(e),
    };
    message.signature = match signed {
        Ok(sig) => sig,
        Err(e) => return Err(fail(state, &format!("Sign error: {e}"))),
    };

    state.phase = HandshakePhase::Established;
    state.session_id = Some(session_id);
    state.updated_at = clock::now();

    Ok((state, message))
}

/// Handles an ESTABLISHED in CommitSent from, and signed by, the collective we committed to.
pub async fn handle_established(
    state: HandshakeState,
    established: &EstablishedMessage,
    callbacks: &dyn HandshakeCallbacks,
) -> HandshakeState {
    if state.phase != HandshakePhase::CommitSent {
        return fail(state, "Unexpected ESTABLISHED").0;
    }
    let Some(remote_did) = state.remote_did.clone() else {
        return fail(state, "No remote DID for ESTABLISHED").0;
    };
    if established.collective_did != remote_did {
        return fail(state, "ESTABLISHED from unexpected sender").0;
    }
    if established.session_id.is_empty() {
        return fail(state, "ESTABLISHED without session id").0;
    }
    if !verify_signed(&remote_did, established, &established.signature, callbacks).await {
        return fail(state, "Invalid ESTABLISHED signature").0;
    }

    let mut state = state;
    state.phase = HandshakePhase::Established;
    state.session_id = Some(established.session_id.clone());
    state.keepalive_seconds = Some(established.keepalive_interval_seconds);
    state.updated_at = clock::now();
    state
}


#[cfg(test)]
mod tests {
    use super::*;

    /// Accepts every signature and policy, signs as "mock-sig", and has no local routes.
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

        let (initiator_state, commit) =
            handle_challenge(initiator_state, &challenge, &cb).await.unwrap();

        assert_eq!(initiator_state.phase, HandshakePhase::CommitSent);
        assert_eq!(commit.collective_did, "did:web:initiator");
        assert_eq!(commit.challenge_nonce, challenge.nonce);
        assert!(!commit.initial_routes.is_empty());

        let (responder_state, established) =
            handle_commit(responder_state, &commit, &cb).await.unwrap();

        assert_eq!(responder_state.phase, HandshakePhase::Established);
        assert!(responder_state.session_id.is_some());
        assert!(!established.session_id.is_empty());
        assert!(!established.initial_routes.is_empty());

        let initiator_state = handle_established(initiator_state, &established, &cb).await;
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
            expires_at: clock::to_rfc3339(clock::now() + Duration::seconds(120)),
            accepted_type: FederationType::Peer,
            accepted_cidrs: vec![],
            accepted_capabilities: vec![],
            negotiated_version: "1.0.0".into(),
            negotiated_keepalive_seconds: 60,
            signature: "sig".into(),
            timestamp: clock::to_rfc3339(clock::now()),
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
        state.remote_did = Some("did:web:remote".to_string());
        state.challenge_nonce = Some("a".repeat(64));
        state.challenge_expires_at =
            Some(clock::now() + Duration::seconds(120));

        let commit = CommitMessage {
            collective_did: "did:web:remote".into(),
            challenge_nonce: "b".repeat(64),
            challenge_signature: "sig".into(),
            initial_routes: vec![],
            signature: "sig".into(),
            timestamp: clock::to_rfc3339(clock::now()),
        };

        let result = handle_commit(state, &commit, &cb).await;
        assert!(result.is_err());
        let (_, err_msg) = result.unwrap_err();
        assert!(err_msg.contains("nonce mismatch"));
    }

    #[tokio::test]
    async fn handle_established_rejects_wrong_phase() {
        let state = create_handshake("did:web:local");
        // State is Idle, not CommitSent.
        let established = EstablishedMessage {
            session_id: "sess-1".into(),
            collective_did: "did:web:remote".into(),
            initial_routes: vec![],
            keepalive_interval_seconds: 60,
            signature: "sig".into(),
            timestamp: clock::to_rfc3339(clock::now()),
        };

        let state = handle_established(state, &established, &MockCallbacks).await;
        assert_eq!(state.phase, HandshakePhase::Failed);
    }

    #[tokio::test]
    async fn handle_hello_policy_rejection() {
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
            timestamp: clock::to_rfc3339(clock::now()),
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

    // The mocks above accept any signature, so they miss sign/verify payload mismatches.
    // These tests use HMAC-SHA256 with one key per DID, so a signature verifies only over its exact bytes.
    // The crate has no asymmetric signer. The embedding service injects real keys.

    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    use std::collections::HashMap;

    struct RealCallbacks {
        me: String,
        keys: HashMap<String, Vec<u8>>,
        routes: Vec<RouteAnnouncement>,
    }

    impl RealCallbacks {
        fn new(me: &str, routes: Vec<RouteAnnouncement>) -> Self {
            let keys = ["did:web:alpha", "did:web:beta", "did:web:mallory"]
                .iter()
                .map(|d| (d.to_string(), format!("key-of-{d}").into_bytes()))
                .collect();
            Self { me: me.to_string(), keys, routes }
        }

        fn mac(&self, did: &str, payload: &str) -> Option<String> {
            let key = self.keys.get(did)?;
            let mut mac = Hmac::<Sha256>::new_from_slice(key).ok()?;
            mac.update(payload.as_bytes());
            Some(hex::encode(mac.finalize().into_bytes()))
        }
    }

    #[async_trait]
    impl HandshakeCallbacks for RealCallbacks {
        async fn sign(&self, payload: &str) -> Result<String, CoordError> {
            self.mac(&self.me, payload)
                .ok_or_else(|| CoordError::Protocol("no key".into()))
        }
        async fn verify_signature(
            &self,
            did: &str,
            payload: &str,
            signature: &str,
        ) -> Result<bool, CoordError> {
            Ok(self.mac(did, payload).as_deref() == Some(signature))
        }
        async fn evaluate_policy(&self, _: &str, _: &FederationType) -> Result<bool, CoordError> {
            Ok(true)
        }
        fn get_local_routes(&self) -> Vec<RouteAnnouncement> {
            self.routes.clone()
        }
    }

    fn route(prefix: &str, origin: &str) -> RouteAnnouncement {
        RouteAnnouncement {
            prefix: prefix.into(),
            origin_did: origin.into(),
            path_vector: vec![origin.into()],
            community_tags: vec![],
            preference: 100,
            origin_signature: "osig".into(),
        }
    }

    /// Serialize and parse a message, as an HTTP hop does.
    fn wire<T: serde::Serialize + serde::de::DeserializeOwned>(m: &T) -> T {
        serde_json::from_str(&serde_json::to_string(m).unwrap()).unwrap()
    }

    #[tokio::test]
    async fn real_signatures_full_handshake() {
        let alpha = RealCallbacks::new("did:web:alpha", vec![route("10.1.0.0/24", "did:web:alpha")]);
        let beta = RealCallbacks::new("did:web:beta", vec![route("10.2.0.0/24", "did:web:beta")]);

        let (a_state, hello) = initiate_hello(
            create_handshake("did:web:alpha"),
            "did:web:beta",
            FederationType::Peer,
            vec!["10.1.0.0/24".into()],
            vec![Capability::RouteExchange],
            &alpha,
        )
        .await
        .unwrap();

        let (b_state, challenge) = handle_hello(
            create_handshake("did:web:beta"),
            &wire(&hello),
            &["10.2.0.0/24".into()],
            &[Capability::RouteExchange],
            &beta,
        )
        .await
        .expect("HELLO signed by the initiator must verify");

        let (a_state, commit) = handle_challenge(a_state, &wire(&challenge), &alpha)
            .await
            .expect("CHALLENGE signed by the responder must verify");

        let (b_state, established) = handle_commit(b_state, &wire(&commit), &beta)
            .await
            .expect("COMMIT signed by the initiator must verify");
        assert_eq!(b_state.phase, HandshakePhase::Established);

        let a_state = handle_established(a_state, &wire(&established), &alpha).await;
        assert_eq!(a_state.phase, HandshakePhase::Established, "{:?}", a_state.error);
        assert_eq!(a_state.session_id, b_state.session_id);
    }

    #[tokio::test]
    async fn real_signatures_reject_tampered_hello() {
        let alpha = RealCallbacks::new("did:web:alpha", vec![]);
        let beta = RealCallbacks::new("did:web:beta", vec![]);
        let (_, mut hello) = initiate_hello(
            create_handshake("did:web:alpha"),
            "did:web:beta",
            FederationType::Peer,
            vec!["10.1.0.0/24".into()],
            vec![Capability::RouteExchange],
            &alpha,
        )
        .await
        .unwrap();
        hello.offered_cidrs = vec!["0.0.0.0/0".into()];
        let err = handle_hello(create_handshake("did:web:beta"), &hello, &[], &[], &beta)
            .await
            .unwrap_err();
        assert!(err.1.contains("Invalid HELLO signature"));
    }

    async fn up_to_commit() -> (HandshakeState, CommitMessage, RealCallbacks) {
        let alpha = RealCallbacks::new("did:web:alpha", vec![route("10.1.0.0/24", "did:web:alpha")]);
        let beta = RealCallbacks::new("did:web:beta", vec![]);
        let (a_state, hello) = initiate_hello(
            create_handshake("did:web:alpha"),
            "did:web:beta",
            FederationType::Peer,
            vec![],
            vec![Capability::RouteExchange],
            &alpha,
        )
        .await
        .unwrap();
        let (b_state, challenge) =
            handle_hello(create_handshake("did:web:beta"), &hello, &[], &[], &beta)
                .await
                .unwrap();
        let (_, commit) = handle_challenge(a_state, &challenge, &alpha).await.unwrap();
        (b_state, commit, beta)
    }

    #[tokio::test]
    async fn real_signatures_reject_commit_with_altered_routes() {
        let (b_state, mut commit, beta) = up_to_commit().await;
        commit.initial_routes.push(route("0.0.0.0/0", "did:web:alpha"));
        let err = handle_commit(b_state, &commit, &beta).await.unwrap_err();
        assert!(err.1.contains("Invalid COMMIT signature"), "{}", err.1);
    }

    #[tokio::test]
    async fn real_signatures_reject_commit_from_other_did() {
        let (b_state, mut commit, beta) = up_to_commit().await;
        // Mallory re-signs the COMMIT under her own DID.
        let mallory = RealCallbacks::new("did:web:mallory", vec![]);
        commit.collective_did = "did:web:mallory".into();
        commit.signature = mallory
            .sign(&message_signing_payload(&commit).unwrap())
            .await
            .unwrap();
        let err = handle_commit(b_state, &commit, &beta).await.unwrap_err();
        assert!(err.1.contains("unexpected sender"), "{}", err.1);
    }

    #[tokio::test]
    async fn challenge_response_is_not_a_signature_over_the_bare_nonce() {
        let (b_state, commit, beta) = up_to_commit().await;
        let nonce = b_state.challenge_nonce.clone().unwrap();
        // The response does not verify as a signature over the nonce itself...
        assert!(!beta
            .verify_signature("did:web:alpha", &nonce, &commit.challenge_signature)
            .await
            .unwrap());
        // ...and a signature over the bare nonce is not accepted as a response.
        let alpha = RealCallbacks::new("did:web:alpha", vec![]);
        let mut forged = commit.clone();
        forged.challenge_signature = alpha.sign(&nonce).await.unwrap();
        forged.signature = alpha
            .sign(&message_signing_payload(&forged).unwrap())
            .await
            .unwrap();
        let err = handle_commit(b_state, &forged, &beta).await.unwrap_err();
        assert!(err.1.contains("nonce signature"), "{}", err.1);
    }

    #[tokio::test]
    async fn refuses_to_sign_malformed_nonce() {
        let alpha = RealCallbacks::new("did:web:alpha", vec![]);
        let beta = RealCallbacks::new("did:web:beta", vec![]);
        let (a_state, hello) = initiate_hello(
            create_handshake("did:web:alpha"),
            "did:web:beta",
            FederationType::Peer,
            vec![],
            vec![],
            &alpha,
        )
        .await
        .unwrap();
        let (_, mut challenge) =
            handle_hello(create_handshake("did:web:beta"), &hello, &[], &[], &beta)
                .await
                .unwrap();
        challenge.nonce = r#"{"type":"LINK_REVOKE"}"#.into();
        challenge.signature = beta
            .sign(&message_signing_payload(&challenge).unwrap())
            .await
            .unwrap();
        let err = handle_challenge(a_state, &challenge, &alpha).await.unwrap_err();
        assert!(err.1.contains("Malformed"), "{}", err.1);
    }

    #[tokio::test]
    async fn real_signatures_reject_forged_established() {
        let alpha = RealCallbacks::new("did:web:alpha", vec![]);
        let mut state = create_handshake("did:web:alpha");
        state.phase = HandshakePhase::CommitSent;
        state.remote_did = Some("did:web:beta".into());
        let mallory = RealCallbacks::new("did:web:mallory", vec![]);
        let mut est = EstablishedMessage {
            session_id: "s".into(),
            collective_did: "did:web:beta".into(),
            initial_routes: vec![],
            keepalive_interval_seconds: 60,
            signature: String::new(),
            timestamp: clock::to_rfc3339(clock::now()),
        };
        est.signature = mallory.sign(&message_signing_payload(&est).unwrap()).await.unwrap();
        let state = handle_established(state, &est, &alpha).await;
        assert_eq!(state.phase, HandshakePhase::Failed);
    }
}
