//! In-memory implementation of [`FederationStore`] for development and testing.

use std::collections::HashMap;
use std::sync::RwLock;

use async_trait::async_trait;
use chrono::Utc;

use coord_core::types::{
    BrokerSession, BrokerSessionStatus, CollectiveDid, FederationLink, LinkDirection, LinkId,
    LinkStatus, SessionId, TenantId,
};
use coord_core::CoordError;

use crate::store::FederationStore;

pub struct FederationMemoryStore {
    links: RwLock<HashMap<LinkId, FederationLink>>,
    sessions: RwLock<HashMap<SessionId, BrokerSession>>,
    collective_dids: RwLock<HashMap<TenantId, CollectiveDid>>,
}

impl FederationMemoryStore {
    pub fn new() -> Self {
        Self {
            links: RwLock::new(HashMap::new()),
            sessions: RwLock::new(HashMap::new()),
            collective_dids: RwLock::new(HashMap::new()),
        }
    }
}

impl Default for FederationMemoryStore {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl FederationStore for FederationMemoryStore {
    // ── Links ─────────────────────────────────────────────────────────────

    async fn list_active_links(&self) -> Result<Vec<FederationLink>, CoordError> {
        let guard = self.links.read().unwrap();
        Ok(guard
            .values()
            .filter(|l| l.status == LinkStatus::Active)
            .cloned()
            .collect())
    }

    async fn get_link(&self, id: LinkId) -> Result<Option<FederationLink>, CoordError> {
        let guard = self.links.read().unwrap();
        Ok(guard.get(&id).cloned())
    }

    async fn find_active_link(
        &self,
        tenant_id: TenantId,
        peer_did: &str,
    ) -> Result<Option<FederationLink>, CoordError> {
        let guard = self.links.read().unwrap();
        Ok(guard.values().find(|l| {
            l.local_tenant_id == tenant_id
                && l.peer_did == peer_did
                && l.status == LinkStatus::Active
        }).cloned())
    }

    async fn find_pending_outgoing_link(
        &self,
        tenant_id: TenantId,
        peer_did: &str,
    ) -> Result<Option<FederationLink>, CoordError> {
        let guard = self.links.read().unwrap();
        Ok(guard.values().find(|l| {
            l.local_tenant_id == tenant_id
                && l.peer_did == peer_did
                && l.status == LinkStatus::Pending
                && l.direction == LinkDirection::Outgoing
        }).cloned())
    }

    async fn create_link(&self, link: FederationLink) -> Result<FederationLink, CoordError> {
        let mut guard = self.links.write().unwrap();
        guard.insert(link.id, link.clone());
        Ok(link)
    }

    async fn update_link_status(
        &self,
        id: LinkId,
        status: LinkStatus,
    ) -> Result<(), CoordError> {
        let mut guard = self.links.write().unwrap();
        if let Some(link) = guard.get_mut(&id) {
            link.status = status;
            link.updated_at = Utc::now();
        }
        Ok(())
    }

    async fn update_link_on_accept(
        &self,
        id: LinkId,
        peer_cidrs: Vec<String>,
        peer_broker_url: String,
        peer_name: String,
    ) -> Result<(), CoordError> {
        let mut guard = self.links.write().unwrap();
        if let Some(link) = guard.get_mut(&id) {
            link.status = LinkStatus::Active;
            link.peer_cidrs = peer_cidrs;
            link.peer_broker_url = Some(peer_broker_url);
            link.peer_name = Some(peer_name);
            link.updated_at = Utc::now();
        }
        Ok(())
    }

    // ── Sessions ──────────────────────────────────────────────────────────

    async fn list_sessions(&self) -> Result<Vec<BrokerSession>, CoordError> {
        let guard = self.sessions.read().unwrap();
        Ok(guard.values().cloned().collect())
    }

    async fn get_sessions_for_link(
        &self,
        link_id: LinkId,
    ) -> Result<Vec<BrokerSession>, CoordError> {
        let guard = self.sessions.read().unwrap();
        Ok(guard
            .values()
            .filter(|s| s.federation_link_id == link_id)
            .cloned()
            .collect())
    }

    async fn find_session_by_cfp_id(
        &self,
        cfp_session_id: &str,
        tenant_id: TenantId,
    ) -> Result<Option<BrokerSession>, CoordError> {
        let guard = self.sessions.read().unwrap();
        Ok(guard.values().find(|s| {
            s.local_tenant_id == tenant_id
                && s.cfp_session_id.as_deref() == Some(cfp_session_id)
        }).cloned())
    }

    async fn create_session_if_missing(
        &self,
        session: BrokerSession,
    ) -> Result<Option<BrokerSession>, CoordError> {
        let mut guard = self.sessions.write().unwrap();
        // Check if a session already exists for this link + tenant.
        let exists = guard.values().any(|s| {
            s.federation_link_id == session.federation_link_id
                && s.local_tenant_id == session.local_tenant_id
        });
        if exists {
            return Ok(None);
        }
        guard.insert(session.id, session.clone());
        Ok(Some(session))
    }

    async fn update_session_established(
        &self,
        link_id: LinkId,
        tenant_id: TenantId,
        cfp_session_id: String,
        imported_routes: Vec<String>,
    ) -> Result<(), CoordError> {
        let mut guard = self.sessions.write().unwrap();
        if let Some(session) = guard.values_mut().find(|s| {
            s.federation_link_id == link_id && s.local_tenant_id == tenant_id
        }) {
            session.status = BrokerSessionStatus::Established;
            session.cfp_session_id = Some(cfp_session_id);
            session.imported_routes = imported_routes;
            session.last_keepalive = Some(Utc::now());
            session.updated_at = Utc::now();
        }
        Ok(())
    }

    async fn update_session_keepalive(&self, id: SessionId) -> Result<(), CoordError> {
        let mut guard = self.sessions.write().unwrap();
        if let Some(session) = guard.get_mut(&id) {
            session.last_keepalive = Some(Utc::now());
            session.updated_at = Utc::now();
        }
        Ok(())
    }

    async fn update_session_status(
        &self,
        id: SessionId,
        status: BrokerSessionStatus,
        imported_routes: Option<Vec<String>>,
    ) -> Result<(), CoordError> {
        let mut guard = self.sessions.write().unwrap();
        if let Some(session) = guard.get_mut(&id) {
            session.status = status;
            if let Some(routes) = imported_routes {
                session.imported_routes = routes;
            }
            session.updated_at = Utc::now();
        }
        Ok(())
    }

    async fn delete_session(&self, id: SessionId) -> Result<(), CoordError> {
        let mut guard = self.sessions.write().unwrap();
        guard.remove(&id);
        Ok(())
    }

    async fn get_connecting_sessions_for_incoming_links(
        &self,
    ) -> Result<Vec<(BrokerSession, FederationLink)>, CoordError> {
        let sessions = self.sessions.read().unwrap();
        let links = self.links.read().unwrap();
        let mut result = Vec::new();
        for session in sessions.values() {
            if session.status == BrokerSessionStatus::Connecting {
                if let Some(link) = links.get(&session.federation_link_id) {
                    if link.direction == LinkDirection::Incoming {
                        result.push((session.clone(), link.clone()));
                    }
                }
            }
        }
        Ok(result)
    }

    // ── Collective DIDs ───────────────────────────────────────────────────

    async fn get_collective_did(
        &self,
        tenant_id: TenantId,
    ) -> Result<Option<CollectiveDid>, CoordError> {
        let guard = self.collective_dids.read().unwrap();
        Ok(guard.get(&tenant_id).cloned())
    }

    async fn find_tenant_by_did(&self, did: &str) -> Result<Option<TenantId>, CoordError> {
        let guard = self.collective_dids.read().unwrap();
        Ok(guard
            .values()
            .find(|c| c.did == did)
            .map(|c| c.tenant_id))
    }

    async fn create_collective_did(&self, cdid: CollectiveDid) -> Result<(), CoordError> {
        let mut guard = self.collective_dids.write().unwrap();
        guard.insert(cdid.tenant_id, cdid);
        Ok(())
    }

    async fn delete_collective_did(&self, tenant_id: TenantId) -> Result<(), CoordError> {
        let mut guard = self.collective_dids.write().unwrap();
        guard.remove(&tenant_id);
        Ok(())
    }

    // ── Federation link counts ────────────────────────────────────────────

    async fn count_pending_incoming(&self, tenant_id: TenantId) -> Result<usize, CoordError> {
        let guard = self.links.read().unwrap();
        Ok(guard
            .values()
            .filter(|l| {
                l.local_tenant_id == tenant_id
                    && l.status == LinkStatus::Pending
                    && l.direction == LinkDirection::Incoming
            })
            .count())
    }

    async fn expire_oldest_pending(
        &self,
        tenant_id: TenantId,
        max: usize,
    ) -> Result<usize, CoordError> {
        let mut guard = self.links.write().unwrap();
        let mut pending: Vec<LinkId> = guard
            .values()
            .filter(|l| {
                l.local_tenant_id == tenant_id
                    && l.status == LinkStatus::Pending
                    && l.direction == LinkDirection::Incoming
            })
            .map(|l| (l.id, l.created_at))
            .collect::<Vec<_>>()
            .into_iter()
            // Sort oldest first.
            .map(|(id, _created)| id)
            .collect();

        // Sort by created_at ascending (oldest first).
        pending.sort_by(|a, b| {
            let a_t = guard.get(a).map(|l| l.created_at);
            let b_t = guard.get(b).map(|l| l.created_at);
            a_t.cmp(&b_t)
        });

        let to_expire = if pending.len() > max {
            pending.len() - max
        } else {
            0
        };

        let mut expired = 0;
        for id in pending.into_iter().take(to_expire) {
            if let Some(link) = guard.get_mut(&id) {
                link.status = LinkStatus::Rejected;
                link.message = Some("Expired: too many pending requests".to_string());
                link.updated_at = Utc::now();
                expired += 1;
            }
        }

        Ok(expired)
    }
}
