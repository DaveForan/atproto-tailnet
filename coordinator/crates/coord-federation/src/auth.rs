//! Message authentication primitives for CFP over HTTP (ADR-0016).
//! Signing payloads, freshness checks, imported-route filtering, and announcement builders.

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use coord_core::clock;

use coord_core::CoordError;

use crate::canonical::canonicalize;
use crate::protocol::RouteAnnouncement;


/// Reject signed messages whose timestamp is further than this from now.
pub const MAX_MESSAGE_SKEW: Duration = Duration::from_secs(300); // 5 minutes


/// Boxed async signing function: payload in, signature out.
pub type SignFn =
    Box<dyn Fn(&str) -> Pin<Box<dyn Future<Output = Result<String, CoordError>> + Send>> + Send + Sync>;


/// Canonical signing payload of raw CFP JSON: RFC 8785 JCS without the `signature` member.
/// Byte-identical to the TS `signedPayload`, pinned by `tests/fixtures/cfp_vectors.json`.
/// Verify over the received JSON, since it covers members this crate does not model.
pub fn signed_payload(message: &serde_json::Value) -> Result<String, CoordError> {
    let mut clone = message.clone();
    if let Some(obj) = clone.as_object_mut() {
        obj.remove("signature");
    }
    canonicalize(&clone).map_err(|e| CoordError::Protocol(e.to_string()))
}

/// Signs a message that has no `signature` yet and returns it with one.
pub async fn sign_message(
    message: &serde_json::Value,
    sign_fn: &SignFn,
) -> Result<serde_json::Value, CoordError> {
    let payload = signed_payload(message)?;
    let signature = sign_fn(&payload).await?;
    let mut result = message.clone();
    if let Some(obj) = result.as_object_mut() {
        obj.insert("signature".to_string(), serde_json::Value::String(signature));
    }
    Ok(result)
}

/// Verifies that `message.signature` is `did`'s signature over the rest of the message.
/// `verify_fn` does the cryptographic check, per the `HandshakeCallbacks::verify_signature` contract.
pub async fn verify_message_with_callback<F, Fut>(
    did: &str,
    message: &serde_json::Value,
    verify_fn: F,
) -> Result<bool, CoordError>
where
    F: Fn(&str, &str, &str) -> Fut,
    Fut: Future<Output = Result<bool, CoordError>>,
{
    let signature = match message.get("signature").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s,
        _ => return Ok(false),
    };
    let Ok(payload) = signed_payload(message) else {
        return Ok(false);
    };
    verify_fn(did, &payload, signature).await
}

/// The exact bytes signed for a CFP message: JCS of the object without `signature`, plus the wire `type` tag.
/// Signers and verifiers MUST both use this function. A hand-built payload breaks verification.
/// The bytes equal what the TS service signs for the same message (see `src/cfp_vectors.rs`).
/// A struct round-trip drops unmodelled members and skipped empty arrays.
/// Such peer messages verify only via [`signed_payload`] over the received JSON.
pub fn message_signing_payload<T: crate::protocol::CfpSigned>(
    message: &T,
) -> Result<String, CoordError> {
    let mut value = serde_json::to_value(message)
        .map_err(|e| CoordError::Protocol(format!("cannot serialize {}: {e}", T::MESSAGE_TYPE)))?;
    let obj = value.as_object_mut().ok_or_else(|| {
        CoordError::Protocol(format!("{} did not serialize to an object", T::MESSAGE_TYPE))
    })?;
    obj.remove("signature");
    obj.insert(
        "type".to_string(),
        serde_json::Value::String(T::MESSAGE_TYPE.to_string()),
    );
    canonicalize(&value).map_err(|e| CoordError::Protocol(e.to_string()))
}

/// Type tag of the challenge-response signing payload.
/// It is never a CFP message type, so the signature cannot replay as a CFP message.
pub const CHALLENGE_RESPONSE_TYPE: &str = "CFP_CHALLENGE_RESPONSE";

/// What the initiator signs to answer a CHALLENGE: the nonce bound to signer and audience.
/// # Security
/// Signing the peer-chosen nonce verbatim would make us a signing oracle.
pub fn challenge_response_payload(nonce: &str, signer_did: &str, audience_did: &str) -> String {
    jcs_of_strings(&[
        ("type", CHALLENGE_RESPONSE_TYPE),
        ("iss", signer_did),
        ("aud", audience_did),
        ("nonce", nonce),
    ])
}

/// Signing payload of `originSignature`: JCS of `{prefix, originDid}`, as in the TS `routeOriginPayload`.
pub fn route_origin_payload(prefix: &str, origin_did: &str) -> String {
    jcs_of_strings(&[("prefix", prefix), ("originDid", origin_did)])
}

/// JCS of a flat object of string members (cannot fail: strings only).
fn jcs_of_strings(members: &[(&str, &str)]) -> String {
    let obj: serde_json::Map<String, serde_json::Value> = members
        .iter()
        .map(|(k, v)| ((*k).to_string(), serde_json::Value::String((*v).to_string())))
        .collect();
    canonicalize(&serde_json::Value::Object(obj)).unwrap_or_default()
}

/// Accepts only 32-byte nonces: 64 lowercase hex chars (Rust) or 43 base64url chars (TS).
/// It refuses anything else before signing or lookup.
pub fn is_valid_challenge_nonce(nonce: &str) -> bool {
    let hex = nonce.len() == 64 && nonce.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    let b64url = nonce.len() == 43
        && nonce
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    hex || b64url
}

/// Checks whether a timestamp is within `MAX_MESSAGE_SKEW` of now.
pub fn is_fresh(timestamp: &str) -> bool {
    let Some(parsed) = clock::parse_rfc3339(timestamp) else {
        return false;
    };
    let now = clock::now();
    let diff = (now - parsed).abs();
    diff <= clock::Duration::try_from(MAX_MESSAGE_SKEW).unwrap_or(clock::Duration::seconds(300))
}

/// Keeps only prefixes within the agreed CIDRs that the peer DID originates.
/// A peer must not attract traffic it was not granted.
pub fn filter_imported_prefixes(
    announcements: &[RouteAnnouncement],
    agreed_cidrs: &[String],
    peer_did: &str,
) -> Vec<String> {
    let mut accepted: HashSet<String> = HashSet::new();

    for a in announcements {
        if a.origin_did == peer_did
            && crate::route_engine::prefix_within_scope(&a.prefix, agreed_cidrs)
        {
            accepted.insert(a.prefix.clone());
        }
    }

    accepted.into_iter().collect()
}

/// Build route announcements for CIDRs this side shares on a link.
pub async fn build_announcements(
    local_did: &str,
    cidrs: &[String],
    sign_fn: &SignFn,
) -> Result<Vec<RouteAnnouncement>, CoordError> {
    let mut result = Vec::with_capacity(cidrs.len());
    for prefix in cidrs {
        let origin_signature = sign_fn(&route_origin_payload(prefix, local_did)).await?;
        result.push(RouteAnnouncement {
            prefix: prefix.clone(),
            origin_did: local_did.to_string(),
            path_vector: vec![local_did.to_string()],
            community_tags: vec![],
            preference: 100,
            origin_signature,
        });
    }
    Ok(result)
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_fresh_current_timestamp() {
        let now = clock::to_rfc3339(clock::now());
        assert!(is_fresh(&now));
    }

    #[test]
    fn is_fresh_old_timestamp() {
        let old = clock::to_rfc3339(clock::now() - clock::Duration::seconds(600));
        assert!(!is_fresh(&old));
    }

    #[test]
    fn is_fresh_garbage_returns_false() {
        assert!(!is_fresh("not-a-timestamp"));
        assert!(!is_fresh(""));
    }

    #[test]
    fn is_fresh_within_skew() {
        // 4 minutes ago is inside the 5-minute skew.
        let recent = clock::to_rfc3339(clock::now() - clock::Duration::seconds(240));
        assert!(is_fresh(&recent));
    }

    #[test]
    fn signed_payload_removes_signature() {
        let msg = serde_json::json!({
            "type": "HELLO",
            "collectiveDid": "did:web:test",
            "signature": "should-be-removed",
            "timestamp": "2026-01-01T00:00:00Z",
        });
        let payload = signed_payload(&msg).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert!(parsed.get("signature").is_none());
        assert_eq!(parsed.get("type").unwrap(), "HELLO");
        assert_eq!(
            parsed.get("collectiveDid").unwrap(),
            "did:web:test"
        );
    }

    #[test]
    fn filter_imported_prefixes_basic() {
        let announcements = vec![
            RouteAnnouncement {
                prefix: "10.0.0.0/24".into(),
                origin_did: "did:web:peer".into(),
                path_vector: vec!["did:web:peer".into()],
                community_tags: vec![],
                preference: 100,
                origin_signature: "sig".into(),
            },
            // Different origin: filtered out.
            RouteAnnouncement {
                prefix: "10.0.1.0/24".into(),
                origin_did: "did:web:other".into(),
                path_vector: vec!["did:web:other".into()],
                community_tags: vec![],
                preference: 100,
                origin_signature: "sig".into(),
            },
            // Outside the agreed CIDRs: filtered out.
            RouteAnnouncement {
                prefix: "192.168.0.0/16".into(),
                origin_did: "did:web:peer".into(),
                path_vector: vec!["did:web:peer".into()],
                community_tags: vec![],
                preference: 100,
                origin_signature: "sig".into(),
            },
        ];
        let agreed = vec!["10.0.0.0/24".into(), "10.0.1.0/24".into()];
        let accepted = filter_imported_prefixes(&announcements, &agreed, "did:web:peer");
        assert_eq!(accepted.len(), 1);
        assert!(accepted.contains(&"10.0.0.0/24".to_string()));
    }

    #[test]
    fn filter_imported_prefixes_accepts_sub_prefix() {
        let announcements = vec![RouteAnnouncement {
            prefix: "10.0.1.0/24".into(),
            origin_did: "did:web:peer".into(),
            path_vector: vec!["did:web:peer".into()],
            community_tags: vec![],
            preference: 100,
            origin_signature: "sig".into(),
        }];
        let agreed = vec!["10.0.0.0/16".into()];
        let accepted = filter_imported_prefixes(&announcements, &agreed, "did:web:peer");
        assert_eq!(accepted.len(), 1);
        assert!(accepted.contains(&"10.0.1.0/24".to_string()));
    }

    #[test]
    fn filter_imported_prefixes_rejects_supernet() {
        let announcements = vec![RouteAnnouncement {
            prefix: "10.0.0.0/8".into(),
            origin_did: "did:web:peer".into(),
            path_vector: vec!["did:web:peer".into()],
            community_tags: vec![],
            preference: 100,
            origin_signature: "sig".into(),
        }];
        let agreed = vec!["10.0.0.0/16".into()];
        let accepted = filter_imported_prefixes(&announcements, &agreed, "did:web:peer");
        assert!(accepted.is_empty());
    }

    #[test]
    fn filter_imported_prefixes_empty() {
        let accepted = filter_imported_prefixes(&[], &["10.0.0.0/24".into()], "did:web:peer");
        assert!(accepted.is_empty());
    }

    #[tokio::test]
    async fn build_announcements_creates_correct_structure() {
        let sign_fn: SignFn = Box::new(|_payload: &str| {
            Box::pin(async { Ok("test-sig".to_string()) })
        });

        let cidrs = vec!["10.0.0.0/24".into(), "10.0.1.0/24".into()];
        let announcements = build_announcements("did:web:local", &cidrs, &sign_fn)
            .await
            .unwrap();

        assert_eq!(announcements.len(), 2);
        assert_eq!(announcements[0].prefix, "10.0.0.0/24");
        assert_eq!(announcements[0].origin_did, "did:web:local");
        assert_eq!(announcements[0].path_vector, vec!["did:web:local"]);
        assert_eq!(announcements[0].preference, 100);
        assert_eq!(announcements[0].origin_signature, "test-sig");
        assert_eq!(announcements[1].prefix, "10.0.1.0/24");
    }

    #[tokio::test]
    async fn sign_message_adds_signature_field() {
        let sign_fn: SignFn = Box::new(|_payload: &str| {
            Box::pin(async { Ok("added-sig".to_string()) })
        });

        let msg = serde_json::json!({
            "type": "HELLO",
            "collectiveDid": "did:web:test",
        });

        let signed = sign_message(&msg, &sign_fn).await.unwrap();
        assert_eq!(signed.get("signature").unwrap().as_str().unwrap(), "added-sig");
        assert_eq!(signed.get("type").unwrap(), "HELLO");
    }
}
