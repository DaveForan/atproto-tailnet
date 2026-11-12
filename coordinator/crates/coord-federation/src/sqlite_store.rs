//! SQLite implementation of [`FederationStore`].

use async_trait::async_trait;
use sqlx::SqlitePool;
use uuid::Uuid;

use coord_core::types::{
    BrokerSession, BrokerSessionStatus, CollectiveDid, FederationLink, LinkDirection, LinkId,
    LinkStatus, SessionId, TenantId,
};
use coord_core::{CoordError, StorageError};

use crate::store::FederationStore;

fn db(e: sqlx::Error) -> StorageError {
    StorageError::new(e)
}

// ── Public store struct ──────────────────────────────────────────────────────

pub struct SqliteFederationStore {
    pool: SqlitePool,
}

impl SqliteFederationStore {
    /// Wrap an existing SQLite pool. Assumes migrations have already been
    /// applied by `SqliteStore::new` (shared `migrations_sqlite/` directory).
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
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

fn parse_uuid(s: &str) -> Uuid {
    Uuid::parse_str(s).unwrap_or_default()
}

fn parse_datetime(s: &str) -> chrono::DateTime<chrono::Utc> {
    chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")
        .map(|naive| naive.and_utc())
        .unwrap_or_default()
}

fn parse_string_array(s: &str) -> Vec<String> {
    serde_json::from_str(s).unwrap_or_default()
}

fn encode_string_array(v: &[String]) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "[]".into())
}

// ── Row → domain conversions ─────────────────────────────────────────────────

type LinkTuple = (
    String, String, String, Option<String>, Option<String>,
    String, String, String, String, Option<String>,
    Option<String>, Option<String>, String, String,
);

fn link_from_tuple(r: LinkTuple) -> FederationLink {
    FederationLink {
        id: LinkId::new(parse_uuid(&r.0)),
        local_tenant_id: TenantId::new(parse_uuid(&r.1)),
        peer_did: r.2,
        peer_broker_url: r.3,
        peer_name: r.4,
        direction: parse_direction(&r.5),
        status: parse_link_status(&r.6),
        local_cidrs: parse_string_array(&r.7),
        peer_cidrs: parse_string_array(&r.8),
        protocol_version: r.9,
        message: r.10,
        signed_request: r.11,
        created_at: parse_datetime(&r.12),
        updated_at: parse_datetime(&r.13),
    }
}

type SessionTuple = (
    String, String, String, String, String,
    Option<String>, Option<String>, Option<String>,
    String, String, Option<String>, String, String,
);

fn session_from_tuple(r: SessionTuple) -> BrokerSession {
    BrokerSession {
        id: SessionId::new(parse_uuid(&r.0)),
        federation_link_id: LinkId::new(parse_uuid(&r.1)),
        local_tenant_id: TenantId::new(parse_uuid(&r.2)),
        peer_did: r.3,
        status: parse_session_status(&r.4),
        cfp_session_id: r.5,
        remote_endpoint: r.6,
        protocol_version: r.7,
        exported_routes: parse_string_array(&r.8),
        imported_routes: parse_string_array(&r.9),
        last_keepalive: r.10.as_deref().map(parse_datetime),
        created_at: parse_datetime(&r.11),
        updated_at: parse_datetime(&r.12),
    }
}

type DidTuple = (String, String, String, String, String);

fn did_from_tuple(r: DidTuple) -> CollectiveDid {
    CollectiveDid {
        tenant_id: TenantId::new(parse_uuid(&r.0)),
        did: r.1,
        public_key_jwk: serde_json::from_str(&r.2).unwrap_or_default(),
        encrypted_private_key: r.3,
        created_at: parse_datetime(&r.4),
    }
}

// ── SQL column lists ─────────────────────────────────────────────────────────

const LINK_COLS: &str = "id, local_tenant_id, peer_did, peer_broker_url, peer_name, \
    direction, status, local_cidrs, peer_cidrs, protocol_version, \
    message, signed_request, created_at, updated_at";

const SESSION_COLS: &str = "id, federation_link_id, local_tenant_id, peer_did, status, \
    cfp_session_id, remote_endpoint, protocol_version, \
    exported_routes, imported_routes, last_keepalive, \
    created_at, updated_at";

const DID_COLS: &str = "tenant_id, did, public_key_jwk, encrypted_private_key, created_at";

// ── FederationStore implementation ───────────────────────────────────────────

#[async_trait]
impl FederationStore for SqliteFederationStore {
    // ── Links ────────────────────────────────────────────────────────────

    async fn list_active_links(&self) -> Result<Vec<FederationLink>, CoordError> {
        let sql = format!(
            "SELECT {LINK_COLS} FROM coord_federation_links WHERE status = 'active'"
        );
        let rows = sqlx::query_as::<_, LinkTuple>(&sql)
            .fetch_all(&self.pool)
            .await.map_err(db)?;

        Ok(rows.into_iter().map(link_from_tuple).collect())
    }

    async fn get_link(&self, id: LinkId) -> Result<Option<FederationLink>, CoordError> {
        let sql = format!(
            "SELECT {LINK_COLS} FROM coord_federation_links WHERE id = ?1"
        );
        let row = sqlx::query_as::<_, LinkTuple>(&sql)
            .bind(id.as_uuid().to_string())
            .fetch_optional(&self.pool)
            .await.map_err(db)?;

        Ok(row.map(link_from_tuple))
    }

    async fn find_active_link(
        &self,
        tenant_id: TenantId,
        peer_did: &str,
    ) -> Result<Option<FederationLink>, CoordError> {
        let sql = format!(
            "SELECT {LINK_COLS} FROM coord_federation_links \
             WHERE local_tenant_id = ?1 AND peer_did = ?2 AND status = 'active'"
        );
        let row = sqlx::query_as::<_, LinkTuple>(&sql)
            .bind(tenant_id.as_uuid().to_string())
            .bind(peer_did)
            .fetch_optional(&self.pool)
            .await.map_err(db)?;

        Ok(row.map(link_from_tuple))
    }

    async fn find_pending_outgoing_link(
        &self,
        tenant_id: TenantId,
        peer_did: &str,
    ) -> Result<Option<FederationLink>, CoordError> {
        let sql = format!(
            "SELECT {LINK_COLS} FROM coord_federation_links \
             WHERE local_tenant_id = ?1 AND peer_did = ?2 \
                   AND status = 'pending' AND direction = 'outgoing'"
        );
        let row = sqlx::query_as::<_, LinkTuple>(&sql)
            .bind(tenant_id.as_uuid().to_string())
            .bind(peer_did)
            .fetch_optional(&self.pool)
            .await.map_err(db)?;

        Ok(row.map(link_from_tuple))
    }

    async fn create_link(&self, link: FederationLink) -> Result<FederationLink, CoordError> {
        let sql = format!(
            "INSERT INTO coord_federation_links \
                ({LINK_COLS}) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14) \
             RETURNING {LINK_COLS}"
        );
        let row = sqlx::query_as::<_, LinkTuple>(&sql)
            .bind(link.id.as_uuid().to_string())
            .bind(link.local_tenant_id.as_uuid().to_string())
            .bind(&link.peer_did)
            .bind(&link.peer_broker_url)
            .bind(&link.peer_name)
            .bind(direction_str(link.direction))
            .bind(link_status_str(link.status))
            .bind(encode_string_array(&link.local_cidrs))
            .bind(encode_string_array(&link.peer_cidrs))
            .bind(&link.protocol_version)
            .bind(&link.message)
            .bind(&link.signed_request)
            .bind(link.created_at.format("%Y-%m-%d %H:%M:%S").to_string())
            .bind(link.updated_at.format("%Y-%m-%d %H:%M:%S").to_string())
            .fetch_one(&self.pool)
            .await.map_err(db)?;

        Ok(link_from_tuple(row))
    }

    async fn update_link_status(
        &self,
        id: LinkId,
        status: LinkStatus,
    ) -> Result<(), CoordError> {
        sqlx::query(
            "UPDATE coord_federation_links \
             SET status = ?2, updated_at = datetime('now') \
             WHERE id = ?1",
        )
        .bind(id.as_uuid().to_string())
        .bind(link_status_str(status))
        .execute(&self.pool)
        .await.map_err(db)?;

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
             SET status = 'active', peer_cidrs = ?2, peer_broker_url = ?3, \
                 peer_name = ?4, updated_at = datetime('now') \
             WHERE id = ?1",
        )
        .bind(id.as_uuid().to_string())
        .bind(encode_string_array(&peer_cidrs))
        .bind(&peer_broker_url)
        .bind(&peer_name)
        .execute(&self.pool)
        .await.map_err(db)?;

        Ok(())
    }

    // ── Sessions ─────────────────────────────────────────────────────────

    async fn list_sessions(&self) -> Result<Vec<BrokerSession>, CoordError> {
        let sql = format!(
            "SELECT {SESSION_COLS} FROM coord_broker_sessions"
        );
        let rows = sqlx::query_as::<_, SessionTuple>(&sql)
            .fetch_all(&self.pool)
            .await.map_err(db)?;

        Ok(rows.into_iter().map(session_from_tuple).collect())
    }

    async fn get_sessions_for_link(
        &self,
        link_id: LinkId,
    ) -> Result<Vec<BrokerSession>, CoordError> {
        let sql = format!(
            "SELECT {SESSION_COLS} FROM coord_broker_sessions WHERE federation_link_id = ?1"
        );
        let rows = sqlx::query_as::<_, SessionTuple>(&sql)
            .bind(link_id.as_uuid().to_string())
            .fetch_all(&self.pool)
            .await.map_err(db)?;

        Ok(rows.into_iter().map(session_from_tuple).collect())
    }

    async fn find_session_by_cfp_id(
        &self,
        cfp_session_id: &str,
        tenant_id: TenantId,
    ) -> Result<Option<BrokerSession>, CoordError> {
        let sql = format!(
            "SELECT {SESSION_COLS} FROM coord_broker_sessions \
             WHERE cfp_session_id = ?1 AND local_tenant_id = ?2"
        );
        let row = sqlx::query_as::<_, SessionTuple>(&sql)
            .bind(cfp_session_id)
            .bind(tenant_id.as_uuid().to_string())
            .fetch_optional(&self.pool)
            .await.map_err(db)?;

        Ok(row.map(session_from_tuple))
    }

    async fn create_session_if_missing(
        &self,
        session: BrokerSession,
    ) -> Result<Option<BrokerSession>, CoordError> {
        let sql = format!(
            "INSERT INTO coord_broker_sessions \
                ({SESSION_COLS}) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13) \
             ON CONFLICT (federation_link_id, local_tenant_id) DO NOTHING \
             RETURNING {SESSION_COLS}"
        );
        let row = sqlx::query_as::<_, SessionTuple>(&sql)
            .bind(session.id.as_uuid().to_string())
            .bind(session.federation_link_id.as_uuid().to_string())
            .bind(session.local_tenant_id.as_uuid().to_string())
            .bind(&session.peer_did)
            .bind(session_status_str(session.status))
            .bind(&session.cfp_session_id)
            .bind(&session.remote_endpoint)
            .bind(&session.protocol_version)
            .bind(encode_string_array(&session.exported_routes))
            .bind(encode_string_array(&session.imported_routes))
            .bind(session.last_keepalive.map(|t| t.format("%Y-%m-%d %H:%M:%S").to_string()))
            .bind(session.created_at.format("%Y-%m-%d %H:%M:%S").to_string())
            .bind(session.updated_at.format("%Y-%m-%d %H:%M:%S").to_string())
            .fetch_optional(&self.pool)
            .await.map_err(db)?;

        Ok(row.map(session_from_tuple))
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
             SET status = 'established', cfp_session_id = ?3, \
                 imported_routes = ?4, last_keepalive = datetime('now'), updated_at = datetime('now') \
             WHERE federation_link_id = ?1 AND local_tenant_id = ?2",
        )
        .bind(link_id.as_uuid().to_string())
        .bind(tenant_id.as_uuid().to_string())
        .bind(&cfp_session_id)
        .bind(encode_string_array(&imported_routes))
        .execute(&self.pool)
        .await.map_err(db)?;

        Ok(())
    }

    async fn update_session_keepalive(&self, id: SessionId) -> Result<(), CoordError> {
        sqlx::query(
            "UPDATE coord_broker_sessions \
             SET last_keepalive = datetime('now'), updated_at = datetime('now') \
             WHERE id = ?1",
        )
        .bind(id.as_uuid().to_string())
        .execute(&self.pool)
        .await.map_err(db)?;

        Ok(())
    }

    async fn update_session_status(
        &self,
        id: SessionId,
        status: BrokerSessionStatus,
        imported_routes: Option<Vec<String>>,
    ) -> Result<(), CoordError> {
        match imported_routes {
            Some(routes) => {
                sqlx::query(
                    "UPDATE coord_broker_sessions \
                     SET status = ?2, imported_routes = ?3, updated_at = datetime('now') \
                     WHERE id = ?1",
                )
                .bind(id.as_uuid().to_string())
                .bind(session_status_str(status))
                .bind(encode_string_array(&routes))
                .execute(&self.pool)
                .await.map_err(db)?;
            }
            None => {
                sqlx::query(
                    "UPDATE coord_broker_sessions \
                     SET status = ?2, updated_at = datetime('now') \
                     WHERE id = ?1",
                )
                .bind(id.as_uuid().to_string())
                .bind(session_status_str(status))
                .execute(&self.pool)
                .await.map_err(db)?;
            }
        }

        Ok(())
    }

    async fn delete_session(&self, id: SessionId) -> Result<(), CoordError> {
        sqlx::query("DELETE FROM coord_broker_sessions WHERE id = ?1")
            .bind(id.as_uuid().to_string())
            .execute(&self.pool)
            .await.map_err(db)?;

        Ok(())
    }

    // ── Collective DIDs ──────────────────────────────────────────────────

    async fn get_collective_did(
        &self,
        tenant_id: TenantId,
    ) -> Result<Option<CollectiveDid>, CoordError> {
        let sql = format!(
            "SELECT {DID_COLS} FROM coord_collective_dids WHERE tenant_id = ?1"
        );
        let row = sqlx::query_as::<_, DidTuple>(&sql)
            .bind(tenant_id.as_uuid().to_string())
            .fetch_optional(&self.pool)
            .await.map_err(db)?;

        Ok(row.map(did_from_tuple))
    }

    async fn find_tenant_by_did(&self, did: &str) -> Result<Option<TenantId>, CoordError> {
        let id_str: Option<String> = sqlx::query_scalar(
            "SELECT tenant_id FROM coord_collective_dids WHERE did = ?1",
        )
        .bind(did)
        .fetch_optional(&self.pool)
        .await.map_err(db)?;

        Ok(id_str.map(|s| TenantId::new(parse_uuid(&s))))
    }

    async fn create_collective_did(&self, cdid: CollectiveDid) -> Result<(), CoordError> {
        sqlx::query(
            "INSERT INTO coord_collective_dids \
                (tenant_id, did, public_key_jwk, encrypted_private_key, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .bind(cdid.tenant_id.as_uuid().to_string())
        .bind(&cdid.did)
        .bind(serde_json::to_string(&cdid.public_key_jwk).unwrap_or_default())
        .bind(&cdid.encrypted_private_key)
        .bind(cdid.created_at.format("%Y-%m-%d %H:%M:%S").to_string())
        .execute(&self.pool)
        .await.map_err(db)?;

        Ok(())
    }

    async fn delete_collective_did(&self, tenant_id: TenantId) -> Result<(), CoordError> {
        sqlx::query("DELETE FROM coord_collective_dids WHERE tenant_id = ?1")
            .bind(tenant_id.as_uuid().to_string())
            .execute(&self.pool)
            .await
            .map_err(db)?;

        Ok(())
    }

    // ── Federation link counts ───────────────────────────────────────────

    async fn count_pending_incoming(&self, tenant_id: TenantId) -> Result<usize, CoordError> {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM coord_federation_links \
             WHERE local_tenant_id = ?1 AND direction = 'incoming' AND status = 'pending'",
        )
        .bind(tenant_id.as_uuid().to_string())
        .fetch_one(&self.pool)
        .await.map_err(db)?;

        Ok(count as usize)
    }

    async fn expire_oldest_pending(
        &self,
        tenant_id: TenantId,
        max: usize,
    ) -> Result<usize, CoordError> {
        let tid = tenant_id.as_uuid().to_string();
        let result = sqlx::query(
            "UPDATE coord_federation_links \
             SET status = 'rejected', \
                 message = 'Expired: too many pending requests', \
                 updated_at = datetime('now') \
             WHERE id IN ( \
                 SELECT id FROM coord_federation_links \
                 WHERE local_tenant_id = ?1 \
                   AND direction = 'incoming' \
                   AND status = 'pending' \
                 ORDER BY created_at ASC \
                 LIMIT MAX( \
                     (SELECT COUNT(*) FROM coord_federation_links \
                      WHERE local_tenant_id = ?1 \
                        AND direction = 'incoming' \
                        AND status = 'pending') - ?2, 0) \
             )",
        )
        .bind(&tid)
        .bind(max as i64)
        .execute(&self.pool)
        .await.map_err(db)?;

        Ok(result.rows_affected() as usize)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_helpers_round_trip() {
        assert_eq!(parse_direction("incoming"), LinkDirection::Incoming);
        assert_eq!(parse_direction("outgoing"), LinkDirection::Outgoing);
        assert_eq!(parse_direction("bogus"), LinkDirection::Incoming);

        assert_eq!(parse_link_status("active"), LinkStatus::Active);
        assert_eq!(parse_link_status("bogus"), LinkStatus::Pending);

        assert_eq!(parse_session_status("established"), BrokerSessionStatus::Established);
        assert_eq!(parse_session_status("bogus"), BrokerSessionStatus::Connecting);
    }

    #[test]
    fn string_array_round_trips() {
        let arr = vec!["10.0.0.0/24".to_string(), "10.1.0.0/24".to_string()];
        let encoded = encode_string_array(&arr);
        let decoded = parse_string_array(&encoded);
        assert_eq!(arr, decoded);

        assert_eq!(parse_string_array("[]"), Vec::<String>::new());
        assert_eq!(parse_string_array("garbage"), Vec::<String>::new());
    }
}
