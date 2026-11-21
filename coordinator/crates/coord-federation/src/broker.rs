//! Broker orchestration: reconciliation loop, outbound handshake, session teardown, and ACL routes.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use coord_core::clock;
use tokio::sync::Mutex;
use tracing::{debug, info, warn};

use coord_core::types::{
    BrokerSession, BrokerSessionStatus, LinkId, LinkStatus, SessionId, TenantId,
};
use coord_core::CoordError;

use crate::handshake::HandshakeCallbacks;
use crate::protocol::Capability;
use crate::store::FederationStore;


/// Tag used in Headscale ACL auto-approvers for federation relay routes.
pub const FEDERATION_RELAY_TAG: &str = "tag:federation-relay";


#[derive(Debug, Clone)]
pub struct BrokerConfig {
    /// How often the reconciliation loop runs.
    pub tick_interval: Duration,
    /// A session is stale when its last keepalive is older than this.
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


pub struct BrokerService<S: FederationStore + ?Sized> {
    store: Arc<S>,
    config: BrokerConfig,
    /// Links with a handshake in progress. Prevents concurrent handshakes for one link.
    handshakes_in_flight: Mutex<HashSet<LinkId>>,
}

impl<S: FederationStore + ?Sized> BrokerService<S> {
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

    /// Runs one reconciliation pass: reconcile sessions, report due keepalives, and degrade stale sessions.
    pub async fn tick(&self) -> Result<(), CoordError> {
        self.reconcile_active_sessions().await?;
        self.send_keepalives().await?;
        self.check_session_health().await?;
        Ok(())
    }

    /// Creates sessions for active links, tears down orphans, and retries sessions stuck in connecting.
    async fn reconcile_active_sessions(&self) -> Result<(), CoordError> {
        let active_links = self.store.list_active_links().await?;
        let all_sessions = self.store.list_sessions().await?;

        let links_with_sessions: HashSet<LinkId> = all_sessions
            .iter()
            .map(|s| s.federation_link_id)
            .collect();

        let active_link_ids: HashSet<LinkId> = active_links.iter().map(|l| l.id).collect();

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
                    created_at: clock::now(),
                    updated_at: clock::now(),
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

    /// Logs sessions due a keepalive. The caller's transport sends them.
    /// It must NOT touch `last_keepalive`, which records liveness evidence from the peer.
    /// Only a peer keepalive or [`Self::record_keepalive_ack`] may update it, or stale sessions go undetected.
    async fn send_keepalives(&self) -> Result<(), CoordError> {
        let sessions = self.store.list_sessions().await?;
        for session in &sessions {
            match session.status {
                BrokerSessionStatus::Established | BrokerSessionStatus::Degraded => {
                    debug!(session_id = %session.id, "keepalive due");
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// Records a verified peer acknowledgment of our keepalive and restores a degraded session.
    pub async fn record_keepalive_ack(&self, session_id: SessionId) -> Result<(), CoordError> {
        self.store.update_session_keepalive(session_id).await?;
        if let Some(session) = self
            .store
            .list_sessions()
            .await?
            .into_iter()
            .find(|s| s.id == session_id)
            && session.status == BrokerSessionStatus::Degraded {
                self.store
                    .update_session_status(session_id, BrokerSessionStatus::Established, None)
                    .await?;
            }
        Ok(())
    }

    /// Marks sessions degraded when their last keepalive exceeds `keepalive_stale`.
    async fn check_session_health(&self) -> Result<(), CoordError> {
        let sessions = self.store.list_sessions().await?;
        let now = clock::now();
        let stale_threshold =
            clock::Duration::try_from(self.config.keepalive_stale).unwrap_or(clock::Duration::seconds(90));

        for session in &sessions {
            if session.status != BrokerSessionStatus::Established {
                continue;
            }
            if let Some(last_ka) = session.last_keepalive
                && now - last_ka > stale_threshold {
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
        Ok(())
    }

    /// Starts an outbound handshake for a link.
    /// Returns `true` if started or already in flight, `false` if preconditions fail.
    /// The caller loads the Ed25519 keys and injects them via `callbacks`.
    pub async fn initiate_outbound_handshake(
        &self,
        link_id: LinkId,
        tenant_id: TenantId,
        callbacks: &dyn HandshakeCallbacks,
    ) -> Result<bool, CoordError> {
        // Only one handshake per link runs at a time.
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

        // Always clear the in-flight entry, even on error.
        {
            let mut in_flight = self.handshakes_in_flight.lock().await;
            in_flight.remove(&link_id);
        }

        result
    }

    /// Separate so the caller always clears the in-flight entry.
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

        // This method only prepares HELLO.
        // Nothing here sends it or runs CHALLENGE/COMMIT/ESTABLISHED.

        info!(
            link_id = %link_id,
            peer_did = %link.peer_did,
            "outbound handshake HELLO prepared"
        );

        Ok(true)
    }

    /// Marks a session disconnected and deletes it.
    /// Send a REVOKE to the peer before calling this.
    pub async fn teardown_session(&self, session_id: SessionId) -> Result<(), CoordError> {
        info!(session_id = %session_id, "tearing down session");
        self.store
            .update_session_status(session_id, BrokerSessionStatus::Disconnected, None)
            .await?;
        self.store.delete_session(session_id).await?;
        Ok(())
    }

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


/// Adds `tag:federation-relay` as a route auto-approver for each CIDR in a Headscale ACL policy.
pub fn add_federated_routes_to_policy(
    policy: &serde_json::Value,
    cidrs: &[String],
) -> serde_json::Value {
    let mut result = if policy.is_object() {
        policy.clone()
    } else {
        serde_json::json!({})
    };
    let obj = result.as_object_mut().expect("just verified this is an object");

    let tag_owners = obj
        .entry("tagOwners")
        .or_insert_with(|| serde_json::json!({}));
    if let Some(to) = tag_owners.as_object_mut() {
        to.entry(FEDERATION_RELAY_TAG)
            .or_insert_with(|| serde_json::json!([]));
    }

    let auto_approvers = obj
        .entry("autoApprovers")
        .or_insert_with(|| serde_json::json!({}));
    let routes = auto_approvers
        .as_object_mut()
        .map(|aa| {
            aa.entry("routes")
                .or_insert_with(|| serde_json::json!({}))
        });

    if let Some(routes_val) = routes
        && let Some(routes_obj) = routes_val.as_object_mut() {
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

    result
}

/// Removes the relay-tag approver for each CIDR. Other approvers stay.
/// A CIDR entry with no approvers left is deleted.
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
        let now = clock::now();
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
        let now = clock::now();
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

        // The link is revoked, so its session is an orphan.
        let mut revoked_link = link.clone();
        revoked_link.status = LinkStatus::Revoked;
        store.create_link(revoked_link).await.unwrap();

        let session = make_session(&link);
        store.create_session_if_missing(session.clone()).await.unwrap();

        let broker = BrokerService::new(store.clone(), test_config());
        broker.tick().await.unwrap();

        let sessions = store.list_sessions().await.unwrap();
        assert!(sessions.is_empty());
    }

    #[tokio::test]
    async fn health_check_marks_stale_as_degraded() {
        let store = Arc::new(FederationMemoryStore::new());
        let tenant_id = TenantId::generate();
        let link = make_active_link(tenant_id);
        store.create_link(link.clone()).await.unwrap();

        // An established session with a stale keepalive.
        let mut session = make_session(&link);
        session.last_keepalive = Some(clock::now() - clock::Duration::seconds(120));
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
    async fn tick_does_not_refresh_keepalive_of_silent_peer() {
        let store = Arc::new(FederationMemoryStore::new());
        let tenant_id = TenantId::generate();
        let link = make_active_link(tenant_id);
        store.create_link(link.clone()).await.unwrap();

        let mut session = make_session(&link);
        session.last_keepalive = Some(clock::now() - clock::Duration::seconds(120));
        store.create_session_if_missing(session.clone()).await.unwrap();

        let config = BrokerConfig {
            keepalive_stale: Duration::from_secs(5),
            ..test_config()
        };
        let broker = BrokerService::new(store.clone(), config);
        // A full tick must still see the session as stale.
        broker.tick().await.unwrap();

        let sessions = store.list_sessions().await.unwrap();
        assert_eq!(sessions[0].status, BrokerSessionStatus::Degraded);

        // A peer acknowledgment restores it.
        broker.record_keepalive_ack(session.id).await.unwrap();
        let sessions = store.list_sessions().await.unwrap();
        assert_eq!(sessions[0].status, BrokerSessionStatus::Established);
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


    #[test]
    fn add_federated_routes_to_empty_policy() {
        let policy = serde_json::json!({});
        let result = add_federated_routes_to_policy(&policy, &["10.0.0.0/24".to_string()]);

        let routes = result["autoApprovers"]["routes"]["10.0.0.0/24"]
            .as_array()
            .unwrap();
        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0], FEDERATION_RELAY_TAG);

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

        // No other approvers remain, so the CIDR entry goes.
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
