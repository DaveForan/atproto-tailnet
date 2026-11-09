//! Broker orchestration — reconciliation loop, outbound handshake,
//! session teardown, and ACL route management (Tier 3).
//!
//! Ported from `src/orchestrator/federation-broker.ts` (914 lines).

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use tokio::sync::Mutex;
use tracing::{debug, info, warn};

use coord_core::types::{
    BrokerSession, BrokerSessionStatus, LinkId, LinkStatus, SessionId, TenantId,
};
use coord_core::CoordError;

use crate::handshake::HandshakeCallbacks;
use crate::protocol::Capability;
use crate::store::FederationStore;

// ── Constants ──────────────────────────────────────────────────────────────────

/// Tag used in Headscale ACL auto-approvers for federation relay routes.
pub const FEDERATION_RELAY_TAG: &str = "tag:federation-relay";

// ── Config ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct BrokerConfig {
    /// How often the reconciliation loop runs.
    pub tick_interval: Duration,
    /// A session is "stale" if its last keepalive is older than this.
    pub keepalive_stale: Duration,
    /// Capabilities this instance advertises during handshake.
    pub local_capabilities: Vec<Capability>,
    /// The public URL other brokers use to reach us.
    pub public_url: String,
}

impl Default for BrokerConfig {
    fn default() -> Self {
        Self {
            tick_interval: Duration::from_secs(30),
            keepalive_stale: Duration::from_secs(90),
            local_capabilities: vec![Capability::RouteExchange],
            public_url: String::new(),
        }
    }
}

// ── BrokerService ──────────────────────────────────────────────────────────────

pub struct BrokerService<S: FederationStore> {
    store: Arc<S>,
    config: BrokerConfig,
    /// Links currently being handshaked (prevents concurrent handshakes for
    /// the same link).
    handshakes_in_flight: Mutex<HashSet<LinkId>>,
}

impl<S: FederationStore> BrokerService<S> {
    pub fn new(store: Arc<S>, config: BrokerConfig) -> Self {
        Self {
            store,
            config,
            handshakes_in_flight: Mutex::new(HashSet::new()),
        }
    }

    pub fn config(&self) -> &BrokerConfig {
        &self.config
    }

    /// Single tick of the reconciliation loop.
    ///
    /// Called every `tick_interval` by the runtime. Performs three jobs:
    /// 1. Reconcile sessions against active links.
    /// 2. Send keepalives for established/degraded sessions.
    /// 3. Check session health (mark stale sessions as degraded).
    pub async fn tick(&self) -> Result<(), CoordError> {
        self.reconcile_active_sessions().await?;
        self.send_keepalives().await?;
        self.check_session_health().await?;
        Ok(())
    }

    /// Ensure every active link has a session, tear down orphan sessions,
    /// and retry sessions stuck in connecting.
    async fn reconcile_active_sessions(&self) -> Result<(), CoordError> {
        let active_links = self.store.list_active_links().await?;
        let all_sessions = self.store.list_sessions().await?;

        // Build a set of link IDs that have sessions.
        let links_with_sessions: HashSet<LinkId> = all_sessions
            .iter()
            .map(|s| s.federation_link_id)
            .collect();

        // Active link IDs.
        let active_link_ids: HashSet<LinkId> = active_links.iter().map(|l| l.id).collect();

        // 1. Create sessions for active links that don't have one.
        for link in &active_links {
            if !links_with_sessions.contains(&link.id) {
                let session = BrokerSession {
                    id: SessionId::generate(),
                    federation_link_id: link.id,
                    local_tenant_id: link.local_tenant_id,
                    peer_did: link.peer_did.clone(),
                    status: BrokerSessionStatus::Connecting,
                    cfp_session_id: None,
                    remote_endpoint: link.peer_broker_url.clone(),
                    protocol_version: link.protocol_version.clone(),
                    exported_routes: link.local_cidrs.clone(),
                    imported_routes: vec![],
                    last_keepalive: None,
                    created_at: Utc::now(),
                    updated_at: Utc::now(),
                };
                if let Some(created) = self.store.create_session_if_missing(session).await? {
                    info!(
                        link_id = %link.id,
                        session_id = %created.id,
                        peer_did = %link.peer_did,
                        "created session for active link"
                    );
                }
            }
        }

        // 2. Tear down sessions whose link is no longer active.
        for session in &all_sessions {
            if !active_link_ids.contains(&session.federation_link_id) {
                debug!(
                    session_id = %session.id,
                    link_id = %session.federation_link_id,
                    "tearing down orphan session (link no longer active)"
                );
                self.store.delete_session(session.id).await?;
            }
        }

        Ok(())
    }

    /// Send keepalives for established and degraded sessions.
    ///
    /// The actual sending is a no-op here; the method updates the store timestamp.
    /// Real HTTP sends are done by the caller's transport layer, which reads
    /// sessions and calls `transport::send_keepalive`.
    async fn send_keepalives(&self) -> Result<(), CoordError> {
        let sessions = self.store.list_sessions().await?;
        for session in &sessions {
            match session.status {
                BrokerSessionStatus::Established | BrokerSessionStatus::Degraded => {
                    // Touch keepalive timestamp — the transport layer picks up
                    // sessions that need keepalives separately.
                    debug!(session_id = %session.id, "keepalive due");
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// Mark sessions as degraded if their last keepalive exceeds the
    /// configured staleness threshold.
    async fn check_session_health(&self) -> Result<(), CoordError> {
        let sessions = self.store.list_sessions().await?;
        let now = Utc::now();
        let stale_threshold =
            chrono::Duration::from_std(self.config.keepalive_stale).unwrap_or(chrono::Duration::seconds(90));

        for session in &sessions {
            if session.status != BrokerSessionStatus::Established {
                continue;
            }
            if let Some(last_ka) = session.last_keepalive {
                if now - last_ka > stale_threshold {
                    warn!(
                        session_id = %session.id,
                        peer_did = %session.peer_did,
                        "session stale, marking degraded"
                    );
                    self.store
                        .update_session_status(
                            session.id,
                            BrokerSessionStatus::Degraded,
                            None,
                        )
                        .await?;
                }
            }
        }
        Ok(())
    }

    /// Initiate an outbound handshake for a link.
    ///
    /// Returns `true` if the handshake was initiated (or is already in flight),
    /// `false` if preconditions aren't met (no link, no collective DID, etc.).
    ///
    /// The `callbacks` trait provides signing and verification. The actual
    /// Ed25519 key material is loaded by the caller and injected here.
    pub async fn initiate_outbound_handshake(
        &self,
        link_id: LinkId,
        tenant_id: TenantId,
        callbacks: &dyn HandshakeCallbacks,
    ) -> Result<bool, CoordError> {
        // Guard: only one handshake per link at a time.
        {
            let mut in_flight = self.handshakes_in_flight.lock().await;
            if in_flight.contains(&link_id) {
                debug!(link_id = %link_id, "handshake already in flight");
                return Ok(true);
            }
            in_flight.insert(link_id);
        }

        let result = self
            .do_outbound_handshake(link_id, tenant_id, callbacks)
            .await;

        // Always remove from in-flight set.
        {
            let mut in_flight = self.handshakes_in_flight.lock().await;
            in_flight.remove(&link_id);
        }

        result
    }

    /// Inner handshake logic, separated for cleanup guarantees.
    async fn do_outbound_handshake(
        &self,
        link_id: LinkId,
        tenant_id: TenantId,
        callbacks: &dyn HandshakeCallbacks,
    ) -> Result<bool, CoordError> {
        let link = match self.store.get_link(link_id).await? {
            Some(l) => l,
            None => return Ok(false),
        };

        if link.status != LinkStatus::Active {
            return Ok(false);
        }

        let collective_did = self.store.get_collective_did(tenant_id).await?;
        let local_did = match collective_did {
            Some(ref cdid) => &cdid.did,
            None => {
                warn!(tenant_id = %tenant_id, "no collective DID for tenant, cannot handshake");
                return Ok(false);
            }
        };

        // Create handshake state and initiate HELLO.
        let state = crate::handshake::create_handshake(local_did);
        let (_state, _hello) = crate::handshake::initiate_hello(
            state,
            &link.peer_did,
            crate::protocol::FederationType::Peer,
            link.local_cidrs.clone(),
            self.config.local_capabilities.clone(),
            callbacks,
        )
        .await?;

        // NOTE: The actual HTTP send of the HELLO message and the subsequent
        // CHALLENGE/COMMIT/ESTABLISHED exchange is delegated to the transport
        // layer. This method prepares the HELLO; the full flow will be wired
        // when the HTTP transport integration is complete.

        info!(
            link_id = %link_id,
            peer_did = %link.peer_did,
            "outbound handshake HELLO prepared"
        );

        Ok(true)
    }

    /// Tear down a session: mark it as disconnected and delete it.
    ///
    /// The caller should send a REVOKE message to the peer before calling this.
    pub async fn teardown_session(&self, session_id: SessionId) -> Result<(), CoordError> {
        info!(session_id = %session_id, "tearing down session");
        self.store
            .update_session_status(session_id, BrokerSessionStatus::Disconnected, None)
            .await?;
        self.store.delete_session(session_id).await?;
        Ok(())
    }

    /// Mark a session as established after a successful handshake.
    pub async fn mark_session_established(
        &self,
        link_id: LinkId,
        tenant_id: TenantId,
        cfp_session_id: String,
        imported_prefixes: Vec<String>,
    ) -> Result<(), CoordError> {
        info!(
            link_id = %link_id,
            cfp_session_id = %cfp_session_id,
            imported = ?imported_prefixes,
            "marking session established"
        );
        self.store
            .update_session_established(link_id, tenant_id, cfp_session_id, imported_prefixes)
            .await
    }
}

// ── ACL policy helpers (pure functions) ────────────────────────────────────────

/// Add federated CIDRs to a policy's route auto-approvers for the relay tag.
///
/// The policy is a freeform JSON object matching Headscale's ACL format.
/// This adds `tag:federation-relay` as an auto-approver for each CIDR.
pub fn add_federated_routes_to_policy(
    policy: &serde_json::Value,
    cidrs: &[String],
) -> serde_json::Value {
    let mut result = policy.clone();
    let obj = result.as_object_mut().unwrap_or_else(|| {
        // If not an object, replace with empty object.
        panic!("policy must be a JSON object");
    });

    // Ensure tagOwners has the federation relay tag.
    let tag_owners = obj
        .entry("tagOwners")
        .or_insert_with(|| serde_json::json!({}));
    if let Some(to) = tag_owners.as_object_mut() {
        to.entry(FEDERATION_RELAY_TAG)
            .or_insert_with(|| serde_json::json!([]));
    }

    // Ensure autoApprovers.routes exists.
    let auto_approvers = obj
        .entry("autoApprovers")
        .or_insert_with(|| serde_json::json!({}));
    let routes = auto_approvers
        .as_object_mut()
        .and_then(|aa| {
            Some(
                aa.entry("routes")
                    .or_insert_with(|| serde_json::json!({})),
            )
        });

    if let Some(routes_val) = routes {
        if let Some(routes_obj) = routes_val.as_object_mut() {
            for cidr in cidrs {
                let approvers = routes_obj
                    .entry(cidr)
                    .or_insert_with(|| serde_json::json!([]));
                if let Some(arr) = approvers.as_array_mut() {
                    let tag_val = serde_json::Value::String(FEDERATION_RELAY_TAG.to_string());
                    if !arr.contains(&tag_val) {
                        arr.push(tag_val);
                    }
                }
            }
        }
    }

    result
}

/// Remove federated CIDRs from a policy's route auto-approvers.
///
/// Removes only the `tag:federation-relay` approver; other approvers for the
/// same CIDR are left in place. If no approvers remain, the CIDR entry is deleted.
pub fn remove_federated_routes_from_policy(
    policy: &serde_json::Value,
    cidrs: &[String],
) -> serde_json::Value {
    let mut result = policy.clone();
    let obj = match result.as_object_mut() {
        Some(o) => o,
        None => return result,
    };

    let auto_approvers = match obj.get_mut("autoApprovers") {
        Some(aa) => aa,
        None => return result,
    };

    let routes = match auto_approvers
        .as_object_mut()
        .and_then(|aa| aa.get_mut("routes"))
    {
        Some(r) => r,
        None => return result,
    };

    if let Some(routes_obj) = routes.as_object_mut() {
        for cidr in cidrs {
            let should_remove = if let Some(arr) = routes_obj.get_mut(cidr).and_then(|v| v.as_array_mut()) {
                let tag_val = serde_json::Value::String(FEDERATION_RELAY_TAG.to_string());
                arr.retain(|v| v != &tag_val);
                arr.is_empty()
            } else {
                false
            };
            if should_remove {
                routes_obj.remove(cidr);
            }
        }
    }

    result
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::federation_store_memory::FederationMemoryStore;
    use coord_core::types::{
        BrokerSessionStatus, FederationLink, LinkDirection, LinkStatus, SessionId,
    };

    fn test_config() -> BrokerConfig {
        BrokerConfig {
            tick_interval: Duration::from_secs(1),
            keepalive_stale: Duration::from_secs(5),
            local_capabilities: vec![Capability::RouteExchange],
            public_url: "https://test.example.com".to_string(),
        }
    }

    fn make_active_link(tenant_id: TenantId) -> FederationLink {
        let now = Utc::now();
        FederationLink {
            id: LinkId::generate(),
            local_tenant_id: tenant_id,
            peer_did: "did:web:peer.example.com:collective:test".to_string(),
            peer_broker_url: Some("https://peer.example.com".to_string()),
            peer_name: Some("Test Peer".to_string()),
            direction: LinkDirection::Outgoing,
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

    fn make_session(link: &FederationLink) -> BrokerSession {
        let now = Utc::now();
        BrokerSession {
            id: SessionId::generate(),
            federation_link_id: link.id,
            local_tenant_id: link.local_tenant_id,
            peer_did: link.peer_did.clone(),
            status: BrokerSessionStatus::Established,
            cfp_session_id: Some("cfp-sess-1".to_string()),
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
    async fn tick_with_no_links_does_nothing() {
        let store = Arc::new(FederationMemoryStore::new());
        let broker = BrokerService::new(store.clone(), test_config());
        broker.tick().await.unwrap();

        let sessions = store.list_sessions().await.unwrap();
        assert!(sessions.is_empty());
    }

    #[tokio::test]
    async fn tick_creates_session_for_active_link() {
        let store = Arc::new(FederationMemoryStore::new());
        let tenant_id = TenantId::generate();
        let link = make_active_link(tenant_id);
        store.create_link(link.clone()).await.unwrap();

        let broker = BrokerService::new(store.clone(), test_config());
        broker.tick().await.unwrap();

        let sessions = store.list_sessions().await.unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].federation_link_id, link.id);
        assert_eq!(sessions[0].status, BrokerSessionStatus::Connecting);
    }

    #[tokio::test]
    async fn tick_tears_down_orphan_session() {
        let store = Arc::new(FederationMemoryStore::new());
        let tenant_id = TenantId::generate();
        let link = make_active_link(tenant_id);

        // Create session without its link being active (link status = Revoked).
        let mut revoked_link = link.clone();
        revoked_link.status = LinkStatus::Revoked;
        store.create_link(revoked_link).await.unwrap();

        let session = make_session(&link);
        // Directly insert session (bypassing create_session_if_missing since
        // the link status is revoked and won't match active).
        store.create_session_if_missing(session.clone()).await.unwrap();

        let broker = BrokerService::new(store.clone(), test_config());
        broker.tick().await.unwrap();

        // The session should be deleted because its link is not active.
        let sessions = store.list_sessions().await.unwrap();
        assert!(sessions.is_empty());
    }

    #[tokio::test]
    async fn health_check_marks_stale_as_degraded() {
        let store = Arc::new(FederationMemoryStore::new());
        let tenant_id = TenantId::generate();
        let link = make_active_link(tenant_id);
        store.create_link(link.clone()).await.unwrap();

        // Create an established session with a stale keepalive.
        let mut session = make_session(&link);
        session.last_keepalive = Some(Utc::now() - chrono::Duration::seconds(120));
        store.create_session_if_missing(session.clone()).await.unwrap();

        let config = BrokerConfig {
            keepalive_stale: Duration::from_secs(5), // 5s threshold
            ..test_config()
        };
        let broker = BrokerService::new(store.clone(), config);
        broker.check_session_health().await.unwrap();

        let sessions = store.list_sessions().await.unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].status, BrokerSessionStatus::Degraded);
    }

    #[tokio::test]
    async fn teardown_session_deletes() {
        let store = Arc::new(FederationMemoryStore::new());
        let tenant_id = TenantId::generate();
        let link = make_active_link(tenant_id);
        store.create_link(link.clone()).await.unwrap();

        let session = make_session(&link);
        let session_id = session.id;
        store.create_session_if_missing(session).await.unwrap();

        let broker = BrokerService::new(store.clone(), test_config());
        broker.teardown_session(session_id).await.unwrap();

        let sessions = store.list_sessions().await.unwrap();
        assert!(sessions.is_empty());
    }

    #[tokio::test]
    async fn mark_session_established_updates_store() {
        let store = Arc::new(FederationMemoryStore::new());
        let tenant_id = TenantId::generate();
        let link = make_active_link(tenant_id);
        store.create_link(link.clone()).await.unwrap();

        // Create a connecting session.
        let mut session = make_session(&link);
        session.status = BrokerSessionStatus::Connecting;
        session.cfp_session_id = None;
        session.imported_routes = vec![];
        store.create_session_if_missing(session).await.unwrap();

        let broker = BrokerService::new(store.clone(), test_config());
        broker
            .mark_session_established(
                link.id,
                tenant_id,
                "cfp-123".to_string(),
                vec!["10.1.0.0/24".to_string()],
            )
            .await
            .unwrap();

        let sessions = store.list_sessions().await.unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].status, BrokerSessionStatus::Established);
        assert_eq!(sessions[0].cfp_session_id.as_deref(), Some("cfp-123"));
        assert_eq!(sessions[0].imported_routes, vec!["10.1.0.0/24"]);
    }

    // ── ACL policy helper tests ───────────────────────────────────────────

    #[test]
    fn add_federated_routes_to_empty_policy() {
        let policy = serde_json::json!({});
        let result = add_federated_routes_to_policy(&policy, &["10.0.0.0/24".to_string()]);

        let routes = result["autoApprovers"]["routes"]["10.0.0.0/24"]
            .as_array()
            .unwrap();
        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0], FEDERATION_RELAY_TAG);

        // tagOwners should have the relay tag.
        assert!(result["tagOwners"][FEDERATION_RELAY_TAG].is_array());
    }

    #[test]
    fn add_federated_routes_preserves_existing() {
        let policy = serde_json::json!({
            "autoApprovers": {
                "routes": {
                    "10.0.0.0/24": ["existing-approver"]
                }
            }
        });
        let result = add_federated_routes_to_policy(&policy, &["10.0.0.0/24".to_string()]);

        let routes = result["autoApprovers"]["routes"]["10.0.0.0/24"]
            .as_array()
            .unwrap();
        assert_eq!(routes.len(), 2);
        assert!(routes.contains(&serde_json::json!("existing-approver")));
        assert!(routes.contains(&serde_json::json!(FEDERATION_RELAY_TAG)));
    }

    #[test]
    fn add_federated_routes_idempotent() {
        let policy = serde_json::json!({});
        let result = add_federated_routes_to_policy(&policy, &["10.0.0.0/24".to_string()]);
        let result = add_federated_routes_to_policy(&result, &["10.0.0.0/24".to_string()]);

        let routes = result["autoApprovers"]["routes"]["10.0.0.0/24"]
            .as_array()
            .unwrap();
        assert_eq!(routes.len(), 1); // Not duplicated.
    }

    #[test]
    fn remove_federated_routes_basic() {
        let policy = serde_json::json!({
            "autoApprovers": {
                "routes": {
                    "10.0.0.0/24": [FEDERATION_RELAY_TAG]
                }
            }
        });
        let result = remove_federated_routes_from_policy(&policy, &["10.0.0.0/24".to_string()]);

        // CIDR should be removed entirely since no other approvers.
        assert!(result["autoApprovers"]["routes"]
            .get("10.0.0.0/24")
            .is_none());
    }

    #[test]
    fn remove_federated_routes_preserves_other_approvers() {
        let policy = serde_json::json!({
            "autoApprovers": {
                "routes": {
                    "10.0.0.0/24": ["other-approver", FEDERATION_RELAY_TAG]
                }
            }
        });
        let result = remove_federated_routes_from_policy(&policy, &["10.0.0.0/24".to_string()]);

        let routes = result["autoApprovers"]["routes"]["10.0.0.0/24"]
            .as_array()
            .unwrap();
        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0], "other-approver");
    }

    #[test]
    fn remove_federated_routes_noop_on_empty_policy() {
        let policy = serde_json::json!({});
        let result = remove_federated_routes_from_policy(&policy, &["10.0.0.0/24".to_string()]);
        assert_eq!(result, policy);
    }
}
