//! Federation store trait — persistence abstraction for links, sessions,
//! and collective DIDs (Tier 3).

use async_trait::async_trait;

use coord_core::types::{
    BrokerSession, BrokerSessionStatus, CollectiveDid, FederationLink, LinkId, LinkStatus,
    SessionId, TenantId,
};
use coord_core::CoordError;

#[async_trait]
pub trait FederationStore: Send + Sync {
    // ── Links ─────────────────────────────────────────────────────────────

    /// Return all links whose status is `Active`.
    async fn list_active_links(&self) -> Result<Vec<FederationLink>, CoordError>;

    /// Return a link by its ID.
    async fn get_link(&self, id: LinkId) -> Result<Option<FederationLink>, CoordError>;

    /// Find the active link between a tenant and a peer DID (at most one).
    async fn find_active_link(
        &self,
        tenant_id: TenantId,
        peer_did: &str,
    ) -> Result<Option<FederationLink>, CoordError>;

    /// Persist a new link.
    async fn create_link(&self, link: FederationLink) -> Result<FederationLink, CoordError>;

    /// Update a link's status.
    async fn update_link_status(
        &self,
        id: LinkId,
        status: LinkStatus,
    ) -> Result<(), CoordError>;

    /// Update a link when the remote side accepts: fill in peer CIDRs,
    /// broker URL, and peer name.
    async fn update_link_on_accept(
        &self,
        id: LinkId,
        peer_cidrs: Vec<String>,
        peer_broker_url: String,
        peer_name: String,
    ) -> Result<(), CoordError>;

    // ── Sessions ──────────────────────────────────────────────────────────

    /// Return all broker sessions.
    async fn list_sessions(&self) -> Result<Vec<BrokerSession>, CoordError>;

    /// Return sessions belonging to a given link.
    async fn get_sessions_for_link(
        &self,
        link_id: LinkId,
    ) -> Result<Vec<BrokerSession>, CoordError>;

    /// Find a session by its CFP session ID and tenant.
    async fn find_session_by_cfp_id(
        &self,
        cfp_session_id: &str,
        tenant_id: TenantId,
    ) -> Result<Option<BrokerSession>, CoordError>;

    /// Create a new session if none exists for this link + tenant.
    /// Returns the created session, or `None` if one already exists.
    async fn create_session_if_missing(
        &self,
        session: BrokerSession,
    ) -> Result<Option<BrokerSession>, CoordError>;

    /// Mark a session as established, recording the CFP session ID and
    /// the imported routes.
    async fn update_session_established(
        &self,
        link_id: LinkId,
        tenant_id: TenantId,
        cfp_session_id: String,
        imported_routes: Vec<String>,
    ) -> Result<(), CoordError>;

    /// Touch the keepalive timestamp on a session.
    async fn update_session_keepalive(&self, id: SessionId) -> Result<(), CoordError>;

    /// Update a session's status and optionally its imported routes.
    async fn update_session_status(
        &self,
        id: SessionId,
        status: BrokerSessionStatus,
        imported_routes: Option<Vec<String>>,
    ) -> Result<(), CoordError>;

    /// Delete a session.
    async fn delete_session(&self, id: SessionId) -> Result<(), CoordError>;

    /// Return all sessions in `Connecting` status whose link direction is
    /// `Incoming`, paired with their link.
    async fn get_connecting_sessions_for_incoming_links(
        &self,
    ) -> Result<Vec<(BrokerSession, FederationLink)>, CoordError>;

    // ── Collective DIDs ───────────────────────────────────────────────────

    /// Return the collective DID record for a tenant.
    async fn get_collective_did(
        &self,
        tenant_id: TenantId,
    ) -> Result<Option<CollectiveDid>, CoordError>;

    /// Find which tenant owns a given DID string.
    async fn find_tenant_by_did(&self, did: &str) -> Result<Option<TenantId>, CoordError>;

    /// Store a new collective DID record.
    async fn create_collective_did(&self, cdid: CollectiveDid) -> Result<(), CoordError>;

    /// Delete a tenant's collective DID.
    async fn delete_collective_did(&self, tenant_id: TenantId) -> Result<(), CoordError>;

    // ── Federation link counts ────────────────────────────────────────────

    /// Count pending incoming links for a tenant.
    async fn count_pending_incoming(&self, tenant_id: TenantId) -> Result<usize, CoordError>;

    /// Expire (reject) the oldest pending incoming links beyond `max`,
    /// returning how many were expired.
    async fn expire_oldest_pending(
        &self,
        tenant_id: TenantId,
        max: usize,
    ) -> Result<usize, CoordError>;
}
