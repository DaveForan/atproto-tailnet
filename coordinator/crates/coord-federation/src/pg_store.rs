//! PostgreSQL implementation of [`FederationStore`].

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use coord_core::types::{
    BrokerSession, BrokerSessionStatus, CollectiveDid, FederationLink, LinkDirection, LinkId,
    LinkStatus, SessionId, TenantId,
};
use coord_core::CoordError;

use crate::store::FederationStore;

// ── Public store struct ──────────────────────────────────────────────────────

/// A [`FederationStore`] backed by PostgreSQL via sqlx.
pub struct PgFederationStore {
    pool: PgPool,
}

impl PgFederationStore {
    /// Wrap an existing connection pool.
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

// ── Row types (sqlx::FromRow) ────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct LinkRow {
    id: Uuid,
    local_tenant_id: Uuid,
    peer_did: String,
    peer_broker_url: Option<String>,
    peer_name: Option<String>,
    direction: String,
    status: String,
    local_cidrs: Vec<String>,
    peer_cidrs: Vec<String>,
    protocol_version: Option<String>,
    message: Option<String>,
    signed_request: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(sqlx::FromRow)]
struct SessionRow {
    id: Uuid,
    federation_link_id: Uuid,
    local_tenant_id: Uuid,
    peer_did: String,
    status: String,
    cfp_session_id: Option<String>,
    remote_endpoint: Option<String>,
    protocol_version: Option<String>,
    exported_routes: Vec<String>,
    imported_routes: Vec<String>,
    last_keepalive: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(sqlx::FromRow)]
struct DidRow {
    tenant_id: Uuid,
    did: String,
    public_key_jwk: serde_json::Value,
    encrypted_private_key: String,
    created_at: DateTime<Utc>,
}

// ── Parsing helpers ──────────────────────────────────────────────────────────

fn parse_direction(s: &str) -> LinkDirection {
    match s {
        "outgoing" => LinkDirection::Outgoing,
        _ => LinkDirection::Incoming,
    }
}

fn direction_str(d: LinkDirection) -> &'static str {
    match d {
        LinkDirection::Incoming => "incoming",
        LinkDirection::Outgoing => "outgoing",
    }
}

fn parse_link_status(s: &str) -> LinkStatus {
    match s {
        "active" => LinkStatus::Active,
        "rejected" => LinkStatus::Rejected,
        "revoked" => LinkStatus::Revoked,
        _ => LinkStatus::Pending,
    }
}

fn link_status_str(s: LinkStatus) -> &'static str {
    match s {
        LinkStatus::Pending => "pending",
        LinkStatus::Active => "active",
        LinkStatus::Rejected => "rejected",
        LinkStatus::Revoked => "revoked",
    }
}

fn parse_session_status(s: &str) -> BrokerSessionStatus {
    match s {
        "established" => BrokerSessionStatus::Established,
        "degraded" => BrokerSessionStatus::Degraded,
        "disconnected" => BrokerSessionStatus::Disconnected,
        _ => BrokerSessionStatus::Connecting,
    }
}

fn session_status_str(s: BrokerSessionStatus) -> &'static str {
    match s {
        BrokerSessionStatus::Connecting => "connecting",
        BrokerSessionStatus::Established => "established",
        BrokerSessionStatus::Degraded => "degraded",
        BrokerSessionStatus::Disconnected => "disconnected",
    }
}

// ── Row → domain conversions ─────────────────────────────────────────────────

fn link_from_row(r: LinkRow) -> FederationLink {
    FederationLink {
        id: LinkId::new(r.id),
        local_tenant_id: TenantId::new(r.local_tenant_id),
        peer_did: r.peer_did,
        peer_broker_url: r.peer_broker_url,
        peer_name: r.peer_name,
        direction: parse_direction(&r.direction),
        status: parse_link_status(&r.status),
        local_cidrs: r.local_cidrs,
        peer_cidrs: r.peer_cidrs,
        protocol_version: r.protocol_version,
        message: r.message,
        signed_request: r.signed_request,
        created_at: r.created_at,
        updated_at: r.updated_at,
    }
}

fn session_from_row(r: SessionRow) -> BrokerSession {
    BrokerSession {
        id: SessionId::new(r.id),
        federation_link_id: LinkId::new(r.federation_link_id),
        local_tenant_id: TenantId::new(r.local_tenant_id),
        peer_did: r.peer_did,
        status: parse_session_status(&r.status),
        cfp_session_id: r.cfp_session_id,
        remote_endpoint: r.remote_endpoint,
        protocol_version: r.protocol_version,
        exported_routes: r.exported_routes,
        imported_routes: r.imported_routes,
        last_keepalive: r.last_keepalive,
        created_at: r.created_at,
        updated_at: r.updated_at,
    }
}

fn did_from_row(r: DidRow) -> CollectiveDid {
    CollectiveDid {
        tenant_id: TenantId::new(r.tenant_id),
        did: r.did,
        public_key_jwk: r.public_key_jwk,
        encrypted_private_key: r.encrypted_private_key,
        created_at: r.created_at,
    }
}

// ── FederationStore implementation ───────────────────────────────────────────

#[async_trait]
impl FederationStore for PgFederationStore {
    // ── Links ────────────────────────────────────────────────────────────

    async fn list_active_links(&self) -> Result<Vec<FederationLink>, CoordError> {
        let rows = sqlx::query_as::<_, LinkRow>(
            "SELECT id, local_tenant_id, peer_did, peer_broker_url, peer_name, \
                    direction, status, local_cidrs, peer_cidrs, protocol_version, \
                    message, signed_request, created_at, updated_at \
             FROM coord_federation_links WHERE status = 'active'",
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(rows.into_iter().map(link_from_row).collect())
    }

    async fn get_link(&self, id: LinkId) -> Result<Option<FederationLink>, CoordError> {
        let row = sqlx::query_as::<_, LinkRow>(
            "SELECT id, local_tenant_id, peer_did, peer_broker_url, peer_name, \
                    direction, status, local_cidrs, peer_cidrs, protocol_version, \
                    message, signed_request, created_at, updated_at \
             FROM coord_federation_links WHERE id = $1",
        )
        .bind(id.as_uuid())
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(link_from_row))
    }

    async fn find_active_link(
        &self,
        tenant_id: TenantId,
        peer_did: &str,
    ) -> Result<Option<FederationLink>, CoordError> {
        let row = sqlx::query_as::<_, LinkRow>(
            "SELECT id, local_tenant_id, peer_did, peer_broker_url, peer_name, \
                    direction, status, local_cidrs, peer_cidrs, protocol_version, \
                    message, signed_request, created_at, updated_at \
             FROM coord_federation_links \
             WHERE local_tenant_id = $1 AND peer_did = $2 AND status = 'active'",
        )
        .bind(tenant_id.as_uuid())
        .bind(peer_did)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(link_from_row))
    }

    async fn create_link(&self, link: FederationLink) -> Result<FederationLink, CoordError> {
        let row = sqlx::query_as::<_, LinkRow>(
            "INSERT INTO coord_federation_links \
                (id, local_tenant_id, peer_did, peer_broker_url, peer_name, \
                 direction, status, local_cidrs, peer_cidrs, protocol_version, \
                 message, signed_request, created_at, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) \
             RETURNING id, local_tenant_id, peer_did, peer_broker_url, peer_name, \
                       direction, status, local_cidrs, peer_cidrs, protocol_version, \
                       message, signed_request, created_at, updated_at",
        )
        .bind(link.id.as_uuid())
        .bind(link.local_tenant_id.as_uuid())
        .bind(&link.peer_did)
        .bind(&link.peer_broker_url)
        .bind(&link.peer_name)
        .bind(direction_str(link.direction))
        .bind(link_status_str(link.status))
        .bind(&link.local_cidrs)
        .bind(&link.peer_cidrs)
        .bind(&link.protocol_version)
        .bind(&link.message)
        .bind(&link.signed_request)
        .bind(link.created_at)
        .bind(link.updated_at)
        .fetch_one(&self.pool)
        .await?;

        Ok(link_from_row(row))
    }

    async fn update_link_status(
        &self,
        id: LinkId,
        status: LinkStatus,
    ) -> Result<(), CoordError> {
        sqlx::query(
            "UPDATE coord_federation_links \
             SET status = $2, updated_at = NOW() \
             WHERE id = $1",
        )
        .bind(id.as_uuid())
        .bind(link_status_str(status))
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    async fn update_link_on_accept(
        &self,
        id: LinkId,
        peer_cidrs: Vec<String>,
        peer_broker_url: String,
        peer_name: String,
    ) -> Result<(), CoordError> {
        sqlx::query(
            "UPDATE coord_federation_links \
             SET status = 'active', peer_cidrs = $2, peer_broker_url = $3, \
                 peer_name = $4, updated_at = NOW() \
             WHERE id = $1",
        )
        .bind(id.as_uuid())
        .bind(&peer_cidrs)
        .bind(&peer_broker_url)
        .bind(&peer_name)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    // ── Sessions ─────────────────────────────────────────────────────────

    async fn list_sessions(&self) -> Result<Vec<BrokerSession>, CoordError> {
        let rows = sqlx::query_as::<_, SessionRow>(
            "SELECT id, federation_link_id, local_tenant_id, peer_did, status, \
                    cfp_session_id, remote_endpoint, protocol_version, \
                    exported_routes, imported_routes, last_keepalive, \
                    created_at, updated_at \
             FROM coord_broker_sessions",
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(rows.into_iter().map(session_from_row).collect())
    }

    async fn get_sessions_for_link(
        &self,
        link_id: LinkId,
    ) -> Result<Vec<BrokerSession>, CoordError> {
        let rows = sqlx::query_as::<_, SessionRow>(
            "SELECT id, federation_link_id, local_tenant_id, peer_did, status, \
                    cfp_session_id, remote_endpoint, protocol_version, \
                    exported_routes, imported_routes, last_keepalive, \
                    created_at, updated_at \
             FROM coord_broker_sessions WHERE federation_link_id = $1",
        )
        .bind(link_id.as_uuid())
        .fetch_all(&self.pool)
        .await?;

        Ok(rows.into_iter().map(session_from_row).collect())
    }

    async fn find_session_by_cfp_id(
        &self,
        cfp_session_id: &str,
        tenant_id: TenantId,
    ) -> Result<Option<BrokerSession>, CoordError> {
        let row = sqlx::query_as::<_, SessionRow>(
            "SELECT id, federation_link_id, local_tenant_id, peer_did, status, \
                    cfp_session_id, remote_endpoint, protocol_version, \
                    exported_routes, imported_routes, last_keepalive, \
                    created_at, updated_at \
             FROM coord_broker_sessions \
             WHERE cfp_session_id = $1 AND local_tenant_id = $2",
        )
        .bind(cfp_session_id)
        .bind(tenant_id.as_uuid())
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(session_from_row))
    }

    async fn create_session_if_missing(
        &self,
        session: BrokerSession,
    ) -> Result<Option<BrokerSession>, CoordError> {
        // INSERT ... ON CONFLICT DO NOTHING: if the unique constraint
        // (federation_link_id, local_tenant_id) fires, no row is returned.
        let row = sqlx::query_as::<_, SessionRow>(
            "INSERT INTO coord_broker_sessions \
                (id, federation_link_id, local_tenant_id, peer_did, status, \
                 cfp_session_id, remote_endpoint, protocol_version, \
                 exported_routes, imported_routes, last_keepalive, \
                 created_at, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) \
             ON CONFLICT (federation_link_id, local_tenant_id) DO NOTHING \
             RETURNING id, federation_link_id, local_tenant_id, peer_did, status, \
                       cfp_session_id, remote_endpoint, protocol_version, \
                       exported_routes, imported_routes, last_keepalive, \
                       created_at, updated_at",
        )
        .bind(session.id.as_uuid())
        .bind(session.federation_link_id.as_uuid())
        .bind(session.local_tenant_id.as_uuid())
        .bind(&session.peer_did)
        .bind(session_status_str(session.status))
        .bind(&session.cfp_session_id)
        .bind(&session.remote_endpoint)
        .bind(&session.protocol_version)
        .bind(&session.exported_routes)
        .bind(&session.imported_routes)
        .bind(session.last_keepalive)
        .bind(session.created_at)
        .bind(session.updated_at)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(session_from_row))
    }

    async fn update_session_established(
        &self,
        link_id: LinkId,
        tenant_id: TenantId,
        cfp_session_id: String,
        imported_routes: Vec<String>,
    ) -> Result<(), CoordError> {
        sqlx::query(
            "UPDATE coord_broker_sessions \
             SET status = 'established', cfp_session_id = $3, \
                 imported_routes = $4, last_keepalive = NOW(), updated_at = NOW() \
             WHERE federation_link_id = $1 AND local_tenant_id = $2",
        )
        .bind(link_id.as_uuid())
        .bind(tenant_id.as_uuid())
        .bind(&cfp_session_id)
        .bind(&imported_routes)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    async fn update_session_keepalive(&self, id: SessionId) -> Result<(), CoordError> {
        sqlx::query(
            "UPDATE coord_broker_sessions \
             SET last_keepalive = NOW(), updated_at = NOW() \
             WHERE id = $1",
        )
        .bind(id.as_uuid())
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    async fn update_session_status(
        &self,
        id: SessionId,
        status: BrokerSessionStatus,
        imported_routes: Option<Vec<String>>,
    ) -> Result<(), CoordError> {
        sqlx::query(
            "UPDATE coord_broker_sessions \
             SET status = $2, \
                 imported_routes = COALESCE($3, imported_routes), \
                 updated_at = NOW() \
             WHERE id = $1",
        )
        .bind(id.as_uuid())
        .bind(session_status_str(status))
        .bind(imported_routes.as_deref())
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    async fn delete_session(&self, id: SessionId) -> Result<(), CoordError> {
        sqlx::query("DELETE FROM coord_broker_sessions WHERE id = $1")
            .bind(id.as_uuid())
            .execute(&self.pool)
            .await?;

        Ok(())
    }

    async fn get_connecting_sessions_for_incoming_links(
        &self,
    ) -> Result<Vec<(BrokerSession, FederationLink)>, CoordError> {
        // Join sessions with their links, filtering by session.status =
        // 'connecting' AND link.direction = 'incoming' AND link.status = 'active'.
        //
        // We select all columns from both tables with aliases to disambiguate.
        let rows = sqlx::query_as::<_, JoinedSessionLinkRow>(
            "SELECT \
                s.id AS s_id, s.federation_link_id AS s_federation_link_id, \
                s.local_tenant_id AS s_local_tenant_id, s.peer_did AS s_peer_did, \
                s.status AS s_status, s.cfp_session_id, s.remote_endpoint, \
                s.protocol_version AS s_protocol_version, \
                s.exported_routes, s.imported_routes, s.last_keepalive, \
                s.created_at AS s_created_at, s.updated_at AS s_updated_at, \
                l.id AS l_id, l.local_tenant_id AS l_local_tenant_id, \
                l.peer_did AS l_peer_did, l.peer_broker_url, l.peer_name, \
                l.direction, l.status AS l_status, l.local_cidrs, l.peer_cidrs, \
                l.protocol_version AS l_protocol_version, l.message, l.signed_request, \
                l.created_at AS l_created_at, l.updated_at AS l_updated_at \
             FROM coord_broker_sessions s \
             JOIN coord_federation_links l ON l.id = s.federation_link_id \
             WHERE s.status = 'connecting' \
               AND l.direction = 'incoming' \
               AND l.status = 'active'",
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(rows.into_iter().map(joined_to_pair).collect())
    }

    // ── Collective DIDs ──────────────────────────────────────────────────

    async fn get_collective_did(
        &self,
        tenant_id: TenantId,
    ) -> Result<Option<CollectiveDid>, CoordError> {
        let row = sqlx::query_as::<_, DidRow>(
            "SELECT tenant_id, did, public_key_jwk, encrypted_private_key, created_at \
             FROM coord_collective_dids WHERE tenant_id = $1",
        )
        .bind(tenant_id.as_uuid())
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(did_from_row))
    }

    async fn find_tenant_by_did(&self, did: &str) -> Result<Option<TenantId>, CoordError> {
        let uuid: Option<Uuid> = sqlx::query_scalar(
            "SELECT tenant_id FROM coord_collective_dids WHERE did = $1",
        )
        .bind(did)
        .fetch_optional(&self.pool)
        .await?;

        Ok(uuid.map(TenantId::new))
    }

    async fn create_collective_did(&self, cdid: CollectiveDid) -> Result<(), CoordError> {
        sqlx::query(
            "INSERT INTO coord_collective_dids \
                (tenant_id, did, public_key_jwk, encrypted_private_key, created_at) \
             VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(cdid.tenant_id.as_uuid())
        .bind(&cdid.did)
        .bind(&cdid.public_key_jwk)
        .bind(&cdid.encrypted_private_key)
        .bind(cdid.created_at)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    async fn delete_collective_did(&self, tenant_id: TenantId) -> Result<(), CoordError> {
        sqlx::query("DELETE FROM coord_collective_dids WHERE tenant_id = $1")
            .bind(tenant_id.as_uuid())
            .execute(&self.pool)
            .await?;

        Ok(())
    }

    // ── Federation link counts ───────────────────────────────────────────

    async fn count_pending_incoming(&self, tenant_id: TenantId) -> Result<usize, CoordError> {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM coord_federation_links \
             WHERE local_tenant_id = $1 AND direction = 'incoming' AND status = 'pending'",
        )
        .bind(tenant_id.as_uuid())
        .fetch_one(&self.pool)
        .await?;

        Ok(count as usize)
    }

    async fn expire_oldest_pending(
        &self,
        tenant_id: TenantId,
        max: usize,
    ) -> Result<usize, CoordError> {
        // In a single statement: mark the oldest pending-incoming links
        // beyond `max` as 'rejected'. Uses a subquery to find the IDs to
        // expire, ordered by created_at ascending, skipping the `max` newest.
        let result = sqlx::query(
            "UPDATE coord_federation_links \
             SET status = 'rejected', \
                 message = 'Expired: too many pending requests', \
                 updated_at = NOW() \
             WHERE id IN ( \
                 SELECT id FROM coord_federation_links \
                 WHERE local_tenant_id = $1 \
                   AND direction = 'incoming' \
                   AND status = 'pending' \
                 ORDER BY created_at ASC \
                 LIMIT GREATEST( \
                     (SELECT COUNT(*) FROM coord_federation_links \
                      WHERE local_tenant_id = $1 \
                        AND direction = 'incoming' \
                        AND status = 'pending') - $2, 0) \
             )",
        )
        .bind(tenant_id.as_uuid())
        .bind(max as i64)
        .execute(&self.pool)
        .await?;

        Ok(result.rows_affected() as usize)
    }
}

// ── Joined row for the session+link query ────────────────────────────────────

/// Combined row from the session+link join query.
#[derive(sqlx::FromRow)]
struct JoinedSessionLinkRow {
    // session columns
    s_id: Uuid,
    s_federation_link_id: Uuid,
    s_local_tenant_id: Uuid,
    s_peer_did: String,
    s_status: String,
    cfp_session_id: Option<String>,
    remote_endpoint: Option<String>,
    s_protocol_version: Option<String>,
    exported_routes: Vec<String>,
    imported_routes: Vec<String>,
    last_keepalive: Option<DateTime<Utc>>,
    s_created_at: DateTime<Utc>,
    s_updated_at: DateTime<Utc>,
    // link columns
    l_id: Uuid,
    l_local_tenant_id: Uuid,
    l_peer_did: String,
    peer_broker_url: Option<String>,
    peer_name: Option<String>,
    direction: String,
    l_status: String,
    local_cidrs: Vec<String>,
    peer_cidrs: Vec<String>,
    l_protocol_version: Option<String>,
    message: Option<String>,
    signed_request: Option<String>,
    l_created_at: DateTime<Utc>,
    l_updated_at: DateTime<Utc>,
}

fn joined_to_pair(r: JoinedSessionLinkRow) -> (BrokerSession, FederationLink) {
    let session = BrokerSession {
        id: SessionId::new(r.s_id),
        federation_link_id: LinkId::new(r.s_federation_link_id),
        local_tenant_id: TenantId::new(r.s_local_tenant_id),
        peer_did: r.s_peer_did,
        status: parse_session_status(&r.s_status),
        cfp_session_id: r.cfp_session_id,
        remote_endpoint: r.remote_endpoint,
        protocol_version: r.s_protocol_version,
        exported_routes: r.exported_routes,
        imported_routes: r.imported_routes,
        last_keepalive: r.last_keepalive,
        created_at: r.s_created_at,
        updated_at: r.s_updated_at,
    };
    let link = FederationLink {
        id: LinkId::new(r.l_id),
        local_tenant_id: TenantId::new(r.l_local_tenant_id),
        peer_did: r.l_peer_did,
        peer_broker_url: r.peer_broker_url,
        peer_name: r.peer_name,
        direction: parse_direction(&r.direction),
        status: parse_link_status(&r.l_status),
        local_cidrs: r.local_cidrs,
        peer_cidrs: r.peer_cidrs,
        protocol_version: r.l_protocol_version,
        message: r.message,
        signed_request: r.signed_request,
        created_at: r.l_created_at,
        updated_at: r.l_updated_at,
    };
    (session, link)
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_direction_round_trips() {
        assert_eq!(parse_direction("incoming"), LinkDirection::Incoming);
        assert_eq!(parse_direction("outgoing"), LinkDirection::Outgoing);
        assert_eq!(
            direction_str(LinkDirection::Incoming),
            "incoming"
        );
        assert_eq!(
            direction_str(LinkDirection::Outgoing),
            "outgoing"
        );
    }

    #[test]
    fn parse_link_status_round_trips() {
        for (s, expected) in [
            ("pending", LinkStatus::Pending),
            ("active", LinkStatus::Active),
            ("rejected", LinkStatus::Rejected),
            ("revoked", LinkStatus::Revoked),
        ] {
            assert_eq!(parse_link_status(s), expected);
            assert_eq!(link_status_str(expected), s);
        }
    }

    #[test]
    fn parse_session_status_round_trips() {
        for (s, expected) in [
            ("connecting", BrokerSessionStatus::Connecting),
            ("established", BrokerSessionStatus::Established),
            ("degraded", BrokerSessionStatus::Degraded),
            ("disconnected", BrokerSessionStatus::Disconnected),
        ] {
            assert_eq!(parse_session_status(s), expected);
            assert_eq!(session_status_str(expected), s);
        }
    }

    #[test]
    fn unknown_strings_fall_back_to_defaults() {
        assert_eq!(parse_direction("bogus"), LinkDirection::Incoming);
        assert_eq!(parse_link_status("bogus"), LinkStatus::Pending);
        assert_eq!(parse_session_status("bogus"), BrokerSessionStatus::Connecting);
    }

    #[test]
    fn link_from_row_converts_correctly() {
        let now = Utc::now();
        let row = LinkRow {
            id: Uuid::new_v4(),
            local_tenant_id: Uuid::new_v4(),
            peer_did: "did:web:example.com".into(),
            peer_broker_url: Some("https://example.com/broker".into()),
            peer_name: Some("Test Peer".into()),
            direction: "outgoing".into(),
            status: "active".into(),
            local_cidrs: vec!["10.0.0.0/24".into()],
            peer_cidrs: vec!["10.1.0.0/24".into()],
            protocol_version: Some("1.0".into()),
            message: None,
            signed_request: None,
            created_at: now,
            updated_at: now,
        };
        let link = link_from_row(row);
        assert_eq!(link.direction, LinkDirection::Outgoing);
        assert_eq!(link.status, LinkStatus::Active);
        assert_eq!(link.local_cidrs, vec!["10.0.0.0/24"]);
    }

    #[test]
    fn session_from_row_converts_correctly() {
        let now = Utc::now();
        let row = SessionRow {
            id: Uuid::new_v4(),
            federation_link_id: Uuid::new_v4(),
            local_tenant_id: Uuid::new_v4(),
            peer_did: "did:web:peer.example".into(),
            status: "established".into(),
            cfp_session_id: Some("cfp-123".into()),
            remote_endpoint: Some("https://peer.example/cfp".into()),
            protocol_version: Some("1.0".into()),
            exported_routes: vec!["10.0.0.0/24".into()],
            imported_routes: vec!["10.1.0.0/24".into()],
            last_keepalive: Some(now),
            created_at: now,
            updated_at: now,
        };
        let session = session_from_row(row);
        assert_eq!(session.status, BrokerSessionStatus::Established);
        assert_eq!(session.cfp_session_id, Some("cfp-123".into()));
    }

    #[test]
    fn did_from_row_converts_correctly() {
        let now = Utc::now();
        let row = DidRow {
            tenant_id: Uuid::new_v4(),
            did: "did:web:collective.example".into(),
            public_key_jwk: serde_json::json!({"kty": "OKP", "crv": "Ed25519"}),
            encrypted_private_key: "encrypted-data".into(),
            created_at: now,
        };
        let cdid = did_from_row(row);
        assert_eq!(cdid.did, "did:web:collective.example");
        assert_eq!(
            cdid.public_key_jwk,
            serde_json::json!({"kty": "OKP", "crv": "Ed25519"})
        );
    }
}
