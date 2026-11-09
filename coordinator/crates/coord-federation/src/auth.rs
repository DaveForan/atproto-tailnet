//! Message authentication primitives for CFP over HTTP (ADR-0016).
//!
//! Ported from `src/federation/auth.ts` (105 lines).
//! Canonical signing payloads, freshness checks, imported-route filtering,
//! and route announcement builders.

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;

use coord_core::CoordError;

use crate::protocol::RouteAnnouncement;

// ── Constants ──────────────────────────────────────────────────────────────────

/// Reject signed messages whose timestamp is further than this from now.
pub const MAX_MESSAGE_SKEW: Duration = Duration::from_secs(300); // 5 minutes

// ── Public key resolver ────────────────────────────────────────────────────────

#[async_trait]
pub trait PublicKeyResolver: Send + Sync {
    /// Resolve a DID to its raw public key bytes. Returns `None` if unresolvable.
    async fn resolve(&self, did: &str) -> Option<Vec<u8>>;
}

// ── Sign function type ─────────────────────────────────────────────────────────

/// Boxed async signing function: takes a payload string and returns a signature.
pub type SignFn =
    Box<dyn Fn(&str) -> Pin<Box<dyn Future<Output = Result<String, CoordError>> + Send>> + Send + Sync>;

// ── Functions ──────────────────────────────────────────────────────────────────

/// Canonical signing payload: the message with its `signature` field removed.
/// Matches what `federation/handshake.ts` signs for HELLO / CHALLENGE / ESTABLISHED.
pub fn signed_payload(message: &serde_json::Value) -> String {
    let mut clone = message.clone();
    if let Some(obj) = clone.as_object_mut() {
        obj.remove("signature");
    }
    clone.to_string()
}

/// Sign a message that has no `signature` yet and return it with one appended.
pub async fn sign_message(
    message: &serde_json::Value,
    sign_fn: &SignFn,
) -> Result<serde_json::Value, CoordError> {
    let payload = message.to_string();
    let signature = sign_fn(&payload).await?;
    let mut result = message.clone();
    if let Some(obj) = result.as_object_mut() {
        obj.insert("signature".to_string(), serde_json::Value::String(signature));
    }
    Ok(result)
}

/// Verify that `message.signature` is `did`'s signature over the rest of the message.
///
/// This is a high-level check. The actual cryptographic verification depends on
/// the provided `verify_fn` callback (matching the `HandshakeCallbacks::verify_signature`
/// contract).
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
    let payload = signed_payload(message);
    verify_fn(did, &payload, signature).await
}

/// Check whether a timestamp string is within `MAX_MESSAGE_SKEW` of now.
pub fn is_fresh(timestamp: &str) -> bool {
    let parsed = match timestamp.parse::<chrono::DateTime<Utc>>() {
        Ok(dt) => dt,
        Err(_) => return false,
    };
    let now = Utc::now();
    let diff = (now - parsed).abs();
    diff <= chrono::Duration::from_std(MAX_MESSAGE_SKEW).unwrap_or(chrono::Duration::seconds(300))
}

/// Filter route announcements: only accept prefixes that are in the agreed
/// CIDRs set AND originated by the peer DID. A peer must not attract traffic
/// it was not granted.
pub fn filter_imported_prefixes(
    announcements: &[RouteAnnouncement],
    agreed_cidrs: &[String],
    peer_did: &str,
) -> Vec<String> {
    let agreed: HashSet<&str> = agreed_cidrs.iter().map(|s| s.as_str()).collect();
    let mut accepted: HashSet<String> = HashSet::new();

    for a in announcements {
        if a.origin_did == peer_did && agreed.contains(a.prefix.as_str()) {
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
        let signing_payload = serde_json::json!({
            "prefix": prefix,
            "originDid": local_did,
        });
        let origin_signature = sign_fn(&signing_payload.to_string()).await?;
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

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_fresh_current_timestamp() {
        let now = Utc::now().to_rfc3339();
        assert!(is_fresh(&now));
    }

    #[test]
    fn is_fresh_old_timestamp() {
        let old = (Utc::now() - chrono::Duration::seconds(600)).to_rfc3339();
        assert!(!is_fresh(&old));
    }

    #[test]
    fn is_fresh_garbage_returns_false() {
        assert!(!is_fresh("not-a-timestamp"));
        assert!(!is_fresh(""));
    }

    #[test]
    fn is_fresh_within_skew() {
        // 4 minutes ago should still be fresh (< 5 min skew).
        let recent = (Utc::now() - chrono::Duration::seconds(240)).to_rfc3339();
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
        let payload = signed_payload(&msg);
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
            // Different origin -- should be filtered out.
            RouteAnnouncement {
                prefix: "10.0.1.0/24".into(),
                origin_did: "did:web:other".into(),
                path_vector: vec!["did:web:other".into()],
                community_tags: vec![],
                preference: 100,
                origin_signature: "sig".into(),
            },
            // Not in agreed CIDRs -- should be filtered out.
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
