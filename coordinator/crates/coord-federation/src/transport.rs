//! HTTP transport for inter-instance CFP messages (ADR-0016).
//! Sends handshake, keepalive, and revoke messages between brokers over HTTPS.

use std::time::Duration;

use tracing::warn;

use crate::protocol::{CfpMessage, KeepaliveMessage, RevokeMessage};


/// HTTP request timeout for outbound federation messages.
pub const SEND_TIMEOUT: Duration = Duration::from_secs(10);

/// Header that names the collective DID a message addresses.
/// One broker URL hosts many collectives, so the receiver uses it to pick the tenant and key.
pub const RECIPIENT_HEADER: &str = "CFP-Recipient";


#[derive(Debug, Clone)]
pub struct SendResult {
    pub ok: bool,
    pub response: Option<serde_json::Value>,
    pub error: Option<String>,
}


/// Maps a `CfpMessage` to its URL path slug.
fn message_type_slug(message: &CfpMessage) -> &'static str {
    match message {
        CfpMessage::Hello(_) => "hello",
        CfpMessage::Challenge(_) => "challenge",
        CfpMessage::Commit(_) => "commit",
        CfpMessage::Established(_) => "established",
        CfpMessage::Keepalive(_) => "keepalive",
        CfpMessage::RouteUpdate(_) => "route_update",
        CfpMessage::Revoke(_) => "revoke",
        CfpMessage::LinkRequest(_) => "link_request",
        CfpMessage::LinkAccept(_) => "link_accept",
        CfpMessage::LinkReject(_) => "link_reject",
        CfpMessage::LinkRevoke(_) => "link_revoke",
    }
}

/// Sends a CFP message to `{remote_endpoint}/api/federation/messages/{type}`.
pub async fn send_message(
    client: &reqwest::Client,
    remote_endpoint: &str,
    message: &CfpMessage,
    recipient_did: &str,
) -> SendResult {
    let endpoint = remote_endpoint.trim_end_matches('/');
    let slug = message_type_slug(message);
    let url = format!("{endpoint}/api/federation/messages/{slug}");

    let body = match serde_json::to_value(message) {
        Ok(v) => v,
        Err(e) => {
            return SendResult {
                ok: false,
                response: None,
                error: Some(format!("Serialize error: {e}")),
            };
        }
    };

    let result = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header(RECIPIENT_HEADER, recipient_did)
        .timeout(SEND_TIMEOUT)
        .json(&body)
        .send()
        .await;

    match result {
        Ok(res) => {
            if !res.status().is_success() {
                let status = res.status();
                let body_text = res.text().await.unwrap_or_default();
                warn!(
                    url = %url,
                    status = %status,
                    body = %body_text,
                    "federation message send failed"
                );
                SendResult {
                    ok: false,
                    response: None,
                    error: Some(format!("HTTP {status}: {body_text}")),
                }
            } else {
                let response_json = res.json::<serde_json::Value>().await.ok();
                SendResult {
                    ok: true,
                    response: response_json,
                    error: None,
                }
            }
        }
        Err(e) => {
            warn!(url = %url, err = %e, "federation message send error");
            SendResult {
                ok: false,
                response: None,
                error: Some(e.to_string()),
            }
        }
    }
}

/// Sends a keepalive. Returns `true` if the remote acknowledges it.
pub async fn send_keepalive(
    client: &reqwest::Client,
    endpoint: &str,
    keepalive: &KeepaliveMessage,
    recipient_did: &str,
) -> bool {
    let message = CfpMessage::Keepalive(keepalive.clone());
    send_message(client, endpoint, &message, recipient_did)
        .await
        .ok
}

/// Sends a revoke. Returns `true` if the remote acknowledges it.
pub async fn send_revoke(
    client: &reqwest::Client,
    endpoint: &str,
    revoke: &RevokeMessage,
    recipient_did: &str,
) -> bool {
    let message = CfpMessage::Revoke(revoke.clone());
    send_message(client, endpoint, &message, recipient_did)
        .await
        .ok
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{
        Capability, FederationType, HelloMessage, CFP_VERSION,
    };

    #[test]
    fn message_type_slug_mapping() {
        let hello = CfpMessage::Hello(HelloMessage {
            collective_did: "did:web:test".into(),
            federation_type: FederationType::Peer,
            offered_cidrs: vec![],
            capabilities: vec![Capability::RouteExchange],
            protocol_version: CFP_VERSION.into(),
            mesh_id: None,
            signature: "sig".into(),
            timestamp: "2026-01-01T00:00:00Z".into(),
        });
        assert_eq!(message_type_slug(&hello), "hello");

        let ka = CfpMessage::Keepalive(KeepaliveMessage {
            session_id: "sess-1".into(),
            sequence_number: 1,
            timestamp: "2026-01-01T00:00:00Z".into(),
            signature: None,
        });
        assert_eq!(message_type_slug(&ka), "keepalive");

        let revoke = CfpMessage::Revoke(RevokeMessage {
            session_id: "sess-1".into(),
            reason: None,
            permanent: false,
            signature: "sig".into(),
            timestamp: "2026-01-01T00:00:00Z".into(),
        });
        assert_eq!(message_type_slug(&revoke), "revoke");
    }

    #[test]
    fn constants_are_correct() {
        assert_eq!(SEND_TIMEOUT, Duration::from_secs(10));
        assert_eq!(RECIPIENT_HEADER, "CFP-Recipient");
    }
}
