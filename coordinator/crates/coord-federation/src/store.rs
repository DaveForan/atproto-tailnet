//! Persistence trait for federation links, sessions, and collective DIDs.

use async_trait::async_trait;

use coord_core::types::{
    BrokerSession, BrokerSessionStatus, CollectiveDid, FederationLink, LinkId, LinkStatus,
    SessionId, TenantId,
};
use coord_core::CoordError;

#[async_trait]
pub trait FederationStore: Send + Sync {

    async fn list_active_links(&self) -> Result<Vec<FederationLink>, CoordError>;

    async fn get_link(&self, id: LinkId) -> Result<Option<FederationLink>, CoordError>;

    /// Finds the active link between a tenant and a peer DID (at most one).
    async fn find_active_link(
        &self,
        tenant_id: TenantId,
        peer_did: &str,
    ) -> Result<Option<FederationLink>, CoordError>;

    async fn find_pending_outgoing_link(
        &self,
        tenant_id: TenantId,
        peer_did: &str,
    ) -> Result<Option<FederationLink>, CoordError>;

    async fn create_link(&self, link: FederationLink) -> Result<FederationLink, CoordError>;

    async fn update_link_status(
        &self,
        id: LinkId,
        status: LinkStatus,
    ) -> Result<(), CoordError>;

    /// Applies a remote accept: sets peer CIDRs, broker URL, and peer name.
    async fn update_link_on_accept(
        &self,
        id: LinkId,
        peer_cidrs: Vec<String>,
        peer_broker_url: String,
        peer_name: String,
    ) -> Result<(), CoordError>;


    async fn list_sessions(&self) -> Result<Vec<BrokerSession>, CoordError>;

    async fn get_sessions_for_link(
        &self,
        link_id: LinkId,
    ) -> Result<Vec<BrokerSession>, CoordError>;

    /// Finds a session by its CFP session ID within a tenant.
    async fn find_session_by_cfp_id(
        &self,
        cfp_session_id: &str,
        tenant_id: TenantId,
    ) -> Result<Option<BrokerSession>, CoordError>;

    /// Creates a session for this link and tenant.
    /// Returns `None` if one already exists.
    async fn create_session_if_missing(
        &self,
        session: BrokerSession,
    ) -> Result<Option<BrokerSession>, CoordError>;

    /// Marks a session established and records its CFP session ID and imported routes.
    async fn update_session_established(
        &self,
        link_id: LinkId,
        tenant_id: TenantId,
        cfp_session_id: String,
        imported_routes: Vec<String>,
    ) -> Result<(), CoordError>;

    async fn update_session_keepalive(&self, id: SessionId) -> Result<(), CoordError>;

    /// Updates a session's status and, optionally, its imported routes.
    async fn update_session_status(
        &self,
        id: SessionId,
        status: BrokerSessionStatus,
        imported_routes: Option<Vec<String>>,
    ) -> Result<(), CoordError>;

    async fn delete_session(&self, id: SessionId) -> Result<(), CoordError>;


    async fn get_collective_did(
        &self,
        tenant_id: TenantId,
    ) -> Result<Option<CollectiveDid>, CoordError>;

    async fn find_tenant_by_did(&self, did: &str) -> Result<Option<TenantId>, CoordError>;

    async fn create_collective_did(&self, cdid: CollectiveDid) -> Result<(), CoordError>;

    async fn delete_collective_did(&self, tenant_id: TenantId) -> Result<(), CoordError>;


    async fn count_pending_incoming(&self, tenant_id: TenantId) -> Result<usize, CoordError>;

    /// Rejects the oldest pending incoming links beyond `max` and returns the count.
    async fn expire_oldest_pending(
        &self,
        tenant_id: TenantId,
        max: usize,
    ) -> Result<usize, CoordError>;
}
