use std::net::Ipv4Addr;
use sqlx::SqlitePool;
use tokio::sync::broadcast;

use coord_core::{
    CoordError, CreatedPreAuthKey, FederationPosture, NodeAttrs, NodeDetail, NodeId, NodeInfo,
    NodeRegistration, NodeSummary, PeerInfo, PreAuthGrant, PreAuthKeyInfo, PreAuthKeyOptions,
    StorageError, Tenant, TenantId,
};
use coord_core::clock::{self, Duration, OffsetDateTime};
use crate::memory::PeerEvent;
use crate::{generate_auth_key, generate_random_id};

fn decode_owner_lock(tenant_id: TenantId, row: Option<String>) -> coord_core::LockRead {
    match row {
        None => coord_core::LockRead::Unlocked,
        Some(v) => match serde_json::from_str(&v) {
            Ok(l) => coord_core::LockRead::Locked(l),
            Err(e) => {
                tracing::error!(tenant = %tenant_id, error = %e, "malformed machine lock (treated as locked)");
                coord_core::LockRead::Malformed
            }
        },
    }
}

fn db(e: sqlx::Error) -> StorageError {
    StorageError::new(e)
}

fn db_migrate(e: sqlx::migrate::MigrateError) -> StorageError {
    StorageError::new(e)
}

pub struct SqliteStore {
    pool: SqlitePool,
    peer_tx: broadcast::Sender<PeerEvent>,
    /// Never fires: SQLite serves one process (ADR-0034).
    remote_tx: broadcast::Sender<crate::RemoteEvent>,
}

/// Finishes migration 010: SQLite has no SHA-256 function, so plain-text keys get hashed here.
/// It runs in one transaction before the store is used.
/// Idempotent: a hex digest never starts with "tskey-".
async fn hash_plain_preauth_keys(pool: &SqlitePool) -> Result<(), StorageError> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
    let plain: Vec<String> = sqlx::query_scalar("SELECT key FROM coord_preauth_keys WHERE key LIKE 'tskey-%'")
        .fetch_all(&mut *tx)
        .await
        .map_err(db)?;
    for key in &plain {
        sqlx::query("UPDATE coord_preauth_keys SET key = ?1, key_prefix = ?2 WHERE key = ?3")
            .bind(crate::hash_preauth_key(key))
            .bind(coord_core::preauth_key_prefix(key))
            .bind(key)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
    }
    tx.commit().await.map_err(db)?;
    if !plain.is_empty() {
        tracing::info!(count = plain.len(), "stored pre-auth keys hashed");
    }
    Ok(())
}

impl SqliteStore {
    pub async fn new(pool: SqlitePool) -> Result<Self, StorageError> {
        sqlx::migrate!("../../migrations_sqlite")
            .run(&pool)
            .await
            .map_err(db_migrate)?;
        hash_plain_preauth_keys(&pool).await?;

        let (peer_tx, _) = broadcast::channel(crate::PEER_EVENT_CHANNEL_CAPACITY);
        Ok(Self { pool, peer_tx, remote_tx: broadcast::channel(16).0 })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<PeerEvent> {
        self.peer_tx.subscribe()
    }

    pub fn subscribe_remote(&self) -> broadcast::Receiver<crate::RemoteEvent> {
        self.remote_tx.subscribe()
    }

    pub async fn create_tenant(
        &self,
        slug: String,
        parent_id: Option<TenantId>,
        posture: Option<FederationPosture>,
    ) -> Result<Tenant, CoordError> {
        let id = TenantId::generate();
        let parent_str = parent_id.map(|p| p.as_uuid().to_string());
        let federation_posture = posture.unwrap_or_default();

        // Same lock as set_tenant_parent: the parent cannot become a child before the insert.
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        if let (Some(pid), Some(pid_str)) = (parent_id, &parent_str) {
            let parent_row: Option<(Option<String>,)> = sqlx::query_as("SELECT parent_id FROM coord_tenants WHERE id = ?1")
                .bind(pid_str)
                .fetch_optional(&mut *tx)
                .await
                .map_err(db)?;
            crate::check_create_parent(pid, parent_row.map(|(p,)| p.is_some()))?;
        }

        let existing: Option<(String,)> = sqlx::query_as("SELECT slug FROM coord_tenants WHERE slug = ?1")
            .bind(&slug)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;
        if existing.is_some() {
            return Err(CoordError::Protocol(format!("tenant slug '{}' already exists", slug)));
        }

        sqlx::query(
            "INSERT INTO coord_tenants (id, slug, parent_id, federation_posture) VALUES (?1, ?2, ?3, ?4)"
        )
            .bind(id.as_uuid().to_string())
            .bind(&slug)
            .bind(&parent_str)
            .bind(federation_posture.as_str())
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;

        Ok(Tenant {
            id,
            slug,
            parent_id,
            federation_posture,
            ipv4_prefix: coord_core::DEFAULT_IPV4_PREFIX.into(),
            ipv6_prefix: coord_core::DEFAULT_IPV6_PREFIX.into(),
            created_at: clock::now(),
            suspended: false,
        })
    }

    pub async fn get_tenant(&self, tenant_id: TenantId) -> Option<Tenant> {
        let row = sqlx::query_as::<_, TenantRow>(
            "SELECT id, slug, parent_id, federation_posture, ipv4_prefix, ipv6_prefix, created_at, suspended \
             FROM coord_tenants WHERE id = ?1"
        )
            .bind(tenant_id.as_uuid().to_string())
            .fetch_optional(&self.pool)
            .await
            .ok()??;

        tenant_from_row(row)
    }

    pub async fn get_tenant_access(&self, tenant_id: TenantId) -> coord_core::TenantAccess {
        let row: Option<String> = sqlx::query_scalar("SELECT access FROM coord_tenant_access WHERE tenant_id = ?1")
            .bind(tenant_id.as_uuid().to_string())
            .fetch_optional(&self.pool)
            .await
            .ok()
            .flatten();
        row.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default()
    }

    pub async fn set_tenant_access(&self, tenant_id: TenantId, access: coord_core::TenantAccess) -> Result<(), CoordError> {
        if self.get_tenant(tenant_id).await.is_none() {
            return Err(CoordError::TenantNotFound(tenant_id));
        }
        let value = serde_json::to_string(&access).unwrap_or_default();
        sqlx::query(
            "INSERT INTO coord_tenant_access (tenant_id, access) VALUES (?1, ?2) \
             ON CONFLICT (tenant_id) DO UPDATE SET access = excluded.access, updated_at = datetime('now')"
        )
            .bind(tenant_id.as_uuid().to_string())
            .bind(value)
            .execute(&self.pool)
            .await
            .map_err(db)?;
        Ok(())
    }

    pub async fn get_tenant_dns(&self, tenant_id: TenantId) -> coord_core::TenantDns {
        let row: Option<String> = sqlx::query_scalar("SELECT dns FROM coord_tenant_dns WHERE tenant_id = ?1")
            .bind(tenant_id.as_uuid().to_string())
            .fetch_optional(&self.pool)
            .await
            .ok()
            .flatten();
        row.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default()
    }

    pub async fn set_tenant_dns(&self, tenant_id: TenantId, dns: coord_core::TenantDns) -> Result<(), CoordError> {
        if self.get_tenant(tenant_id).await.is_none() {
            return Err(CoordError::TenantNotFound(tenant_id));
        }
        sqlx::query(
            "INSERT INTO coord_tenant_dns (tenant_id, dns) VALUES (?1, ?2) \
             ON CONFLICT (tenant_id) DO UPDATE SET dns = excluded.dns, updated_at = datetime('now')"
        )
            .bind(tenant_id.as_uuid().to_string())
            .bind(serde_json::to_string(&dns).unwrap_or_default())
            .execute(&self.pool)
            .await
            .map_err(db)?;
        Ok(())
    }

    /// A value that is not valid JSON comes back as `null`.
    /// The kind stays listed, so a reader can tell "unreadable" from "absent".
    pub async fn get_tenant_configs(&self, tenant_id: TenantId) -> Result<Vec<(String, serde_json::Value)>, CoordError> {
        let rows: Vec<(String, String)> = sqlx::query_as("SELECT kind, value FROM coord_tenant_config WHERE tenant_id = ?1")
            .bind(tenant_id.as_uuid().to_string())
            .fetch_all(&self.pool)
            .await
            .map_err(db)?;
        Ok(rows.into_iter().map(|(k, v)| (k, serde_json::from_str(&v).unwrap_or_default())).collect())
    }

    pub async fn list_tenant_configs(&self) -> Result<Vec<(TenantId, String, serde_json::Value)>, CoordError> {
        let rows: Vec<(String, String, String)> = sqlx::query_as("SELECT tenant_id, kind, value FROM coord_tenant_config")
            .fetch_all(&self.pool)
            .await
            .map_err(db)?;
        Ok(rows.into_iter()
            .filter_map(|(t, k, v)| Some((TenantId::new(t.parse().ok()?), k, serde_json::from_str(&v).unwrap_or_default())))
            .collect())
    }

    pub async fn set_tenant_config(&self, tenant_id: TenantId, kind: &str, value: Option<serde_json::Value>) -> Result<(), CoordError> {
        if self.get_tenant(tenant_id).await.is_none() {
            return Err(CoordError::TenantNotFound(tenant_id));
        }
        match value {
            Some(v) => sqlx::query(
                "INSERT INTO coord_tenant_config (tenant_id, kind, value) VALUES (?1, ?2, ?3) \
                 ON CONFLICT (tenant_id, kind) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
            )
                .bind(tenant_id.as_uuid().to_string())
                .bind(kind)
                .bind(v.to_string())
                .execute(&self.pool)
                .await
                .map_err(db)?,
            None => sqlx::query("DELETE FROM coord_tenant_config WHERE tenant_id = ?1 AND kind = ?2")
                .bind(tenant_id.as_uuid().to_string())
                .bind(kind)
                .execute(&self.pool)
                .await
                .map_err(db)?,
        };
        Ok(())
    }

    pub async fn sign_in_start(
        &self,
        id: &str,
        machine_key: &[u8; 32],
        hostname: &str,
        os: &str,
        requester_ip: Option<&str>,
        limits: coord_core::SignInLimits,
    ) -> Result<coord_core::SignInStart, CoordError> {
        let now = crate::now_secs();
        let machine = hex::encode(machine_key);
        // BEGIN IMMEDIATE serializes starts, so concurrent requests cannot pass a cap together
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        sqlx::query("DELETE FROM coord_sign_ins WHERE machine_key = ?1 OR expires_at <= ?2")
            .bind(&machine)
            .bind(now)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        if let Some(ip) = requester_ip {
            let from_ip: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM coord_sign_ins WHERE requester_ip = ?1")
                .bind(ip)
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
            if from_ip >= limits.per_ip {
                tx.commit().await.map_err(db)?;
                return Ok(coord_core::SignInStart::TooManyFromAddress);
            }
        }
        let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM coord_sign_ins")
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
        if total >= limits.total {
            tx.commit().await.map_err(db)?;
            return Ok(coord_core::SignInStart::Full);
        }
        sqlx::query("INSERT INTO coord_sign_ins (id, machine_key, hostname, os, expires_at, requester_ip, requested_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
            .bind(id)
            .bind(&machine)
            .bind(hostname)
            .bind(os)
            .bind(now + coord_core::signin::SIGN_IN_TTL_SECS)
            .bind(requester_ip)
            .bind(now)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(coord_core::SignInStart::Started)
    }

    pub async fn sign_in_get(&self, id: &str) -> Option<coord_core::PendingSignIn> {
        let row: Option<crate::SignInRow> = sqlx::query_as(
            // Only a constant column list is formatted in.
            sqlx::AssertSqlSafe(format!("SELECT {} FROM coord_sign_ins WHERE id = ?1 AND expires_at > ?2", crate::SIGN_IN_COLUMNS))
        )
            .bind(id)
            .bind(crate::now_secs())
            .fetch_optional(&self.pool)
            .await
            .ok()
            .flatten();
        row.and_then(crate::sign_in_from_row)
    }

    pub async fn sign_in_decide(&self, id: &str, decision: &coord_core::SignInDecision) -> bool {
        let Ok(text) = serde_json::to_string(decision) else { return false };
        sqlx::query("UPDATE coord_sign_ins SET decision = ?1 WHERE id = ?2 AND decision IS NULL AND expires_at > ?3")
            .bind(text)
            .bind(id)
            .bind(crate::now_secs())
            .execute(&self.pool)
            .await
            .map(|r| r.rows_affected() == 1)
            .unwrap_or(false)
    }

    pub async fn sign_in_take(&self, id: &str) -> Option<coord_core::SignInDecision> {
        let row: Option<Option<String>> = sqlx::query_scalar(
            "DELETE FROM coord_sign_ins WHERE id = ?1 AND decision IS NOT NULL RETURNING decision"
        )
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .ok()
            .flatten();
        row.flatten().and_then(|d| serde_json::from_str(&d).ok())
    }

    pub async fn offer_gateway(&self, tenant_id: TenantId, offer: &coord_core::GatewayOffer) -> Result<(), CoordError> {
        sqlx::query(
            "INSERT INTO coord_gateway_offers (tenant_id, node_key, machine_key, disco_key, region_id, endpoints) VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
             ON CONFLICT (tenant_id) DO UPDATE SET node_key = excluded.node_key, machine_key = excluded.machine_key, \
             disco_key = excluded.disco_key, region_id = excluded.region_id, endpoints = excluded.endpoints, updated_at = unixepoch()"
        )
            .bind(tenant_id.as_uuid().to_string())
            .bind(hex::encode(offer.node_key))
            .bind(hex::encode(offer.machine_key))
            .bind(hex::encode(offer.disco_key))
            .bind(offer.region_id)
            .bind(crate::encode_gateway_endpoints(offer))
            .execute(&self.pool)
            .await
            .map_err(db)?;
        Ok(())
    }

    pub async fn get_gateway_offer(&self, tenant_id: TenantId) -> Option<coord_core::GatewayOffer> {
        let row: Option<(String, String, String, i32, String)> = sqlx::query_as(
            "SELECT node_key, machine_key, disco_key, region_id, endpoints FROM coord_gateway_offers WHERE tenant_id = ?1"
        )
            .bind(tenant_id.as_uuid().to_string())
            .fetch_optional(&self.pool)
            .await
            .ok()
            .flatten();
        row.and_then(crate::decode_gateway_offer)
    }

    pub async fn relay_heartbeat(&self, relay: &coord_core::RelayInfo) -> Result<(), CoordError> {
        sqlx::query(
            "INSERT INTO coord_relays (region_id, hostname, stun_port, last_seen) VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT (region_id) DO UPDATE SET hostname = excluded.hostname, stun_port = excluded.stun_port, last_seen = excluded.last_seen"
        )
            .bind(relay.region_id)
            .bind(&relay.hostname)
            .bind(i32::from(relay.stun_port))
            .bind(crate::now_secs())
            .execute(&self.pool)
            .await
            .map_err(db)?;
        Ok(())
    }

    pub async fn list_relays(&self, max_age_secs: i64) -> Vec<coord_core::RelayInfo> {
        let rows: Vec<(i32, String, i32)> = sqlx::query_as(
            "SELECT region_id, hostname, stun_port FROM coord_relays WHERE last_seen >= ?1"
        )
            .bind(crate::now_secs() - max_age_secs)
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default();
        rows.into_iter()
            .map(|(region_id, hostname, stun_port)| coord_core::RelayInfo {
                region_id,
                hostname,
                stun_port: u16::try_from(stun_port).unwrap_or(0),
            })
            .collect()
    }

    pub async fn set_home_relay(&self, node_id: NodeId, region: i32) -> Result<bool, CoordError> {
        let row: Option<String> = sqlx::query_scalar(
            "UPDATE coord_nodes SET home_derp = ?1 WHERE id = ?2 AND home_derp IS NOT ?1 RETURNING tenant_id"
        )
            .bind(region)
            .bind(node_id.as_i64())
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?;
        let Some(tenant_text) = row else { return Ok(false) };
        let Ok(tenant_uuid) = tenant_text.parse::<uuid::Uuid>() else { return Ok(false) };
        let tenant_id = TenantId::new(tenant_uuid);
        let _ = self.peer_tx.send(PeerEvent::NodeUpdated { tenant_id, node_id });
        Ok(true)
    }

    pub async fn home_relays(&self, node_ids: &[NodeId]) -> std::collections::HashMap<NodeId, i32> {
        // Node ids are integers, so the list can be written into the statement
        let list = node_ids.iter().map(|n| n.as_i64().to_string()).collect::<Vec<_>>().join(",");
        let rows: Vec<(i64, i32)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT id, home_derp FROM coord_nodes WHERE id IN ({list}) AND home_derp IS NOT NULL"
        )))
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default();
        rows.into_iter().map(|(id, region)| (NodeId::new(id), region)).collect()
    }

    pub async fn list_owner_locks(&self) -> Vec<(TenantId, String, coord_core::OwnerLock)> {
        let rows: Vec<(String, String, String)> = match sqlx::query_as("SELECT tenant_id, owner, lock FROM coord_owner_locks")
            .fetch_all(&self.pool)
            .await
        {
            Ok(r) => r,
            Err(e) => {
                tracing::error!(error = %e, "could not list machine locks");
                return vec![];
            }
        };
        rows.into_iter()
            .filter_map(|(t, o, l)| match serde_json::from_str(&l) {
                Ok(lock) => Some((TenantId::new(t.parse().ok()?), o, lock)),
                Err(e) => {
                    tracing::error!(tenant = %t, error = %e, "malformed machine lock skipped in listing");
                    None
                }
            })
            .collect()
    }

    pub async fn get_owner_lock(&self, tenant_id: TenantId, owner: &str) -> Result<coord_core::LockRead, CoordError> {
        let row: Option<String> = sqlx::query_scalar("SELECT lock FROM coord_owner_locks WHERE tenant_id = ?1 AND owner = ?2")
            .bind(tenant_id.as_uuid().to_string())
            .bind(owner)
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?;
        Ok(decode_owner_lock(tenant_id, row))
    }

    /// BEGIN IMMEDIATE takes the write lock before the read, so updates
    /// (from any connection) cannot interleave.
    pub async fn update_owner_lock<R, F>(&self, tenant_id: TenantId, owner: &str, f: F) -> Result<R, CoordError>
    where
        F: FnOnce(coord_core::LockRead) -> (coord_core::LockWrite, R),
    {
        let tid = tenant_id.as_uuid().to_string();
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let tenant: Option<String> = sqlx::query_scalar("SELECT id FROM coord_tenants WHERE id = ?1")
            .bind(&tid)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;
        if tenant.is_none() {
            return Err(CoordError::TenantNotFound(tenant_id));
        }
        let row: Option<String> = sqlx::query_scalar("SELECT lock FROM coord_owner_locks WHERE tenant_id = ?1 AND owner = ?2")
            .bind(&tid)
            .bind(owner)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;
        let (write, out) = f(decode_owner_lock(tenant_id, row));
        match write {
            coord_core::LockWrite::Keep => {}
            coord_core::LockWrite::Set(l) => {
                let value = serde_json::to_string(&l).map_err(|e| CoordError::Protocol(e.to_string()))?;
                sqlx::query(
                    "INSERT INTO coord_owner_locks (tenant_id, owner, lock) VALUES (?1, ?2, ?3) \
                     ON CONFLICT (tenant_id, owner) DO UPDATE SET lock = excluded.lock, updated_at = datetime('now')"
                )
                    .bind(&tid)
                    .bind(owner)
                    .bind(value)
                    .execute(&mut *tx)
                    .await
                    .map_err(db)?;
            }
            coord_core::LockWrite::Remove => {
                sqlx::query("DELETE FROM coord_owner_locks WHERE tenant_id = ?1 AND owner = ?2")
                    .bind(&tid)
                    .bind(owner)
                    .execute(&mut *tx)
                    .await
                    .map_err(db)?;
            }
        }
        tx.commit().await.map_err(db)?;
        Ok(out)
    }

    pub async fn list_tenants(&self) -> Vec<Tenant> {
        let rows = sqlx::query_as::<_, TenantRow>(
            "SELECT id, slug, parent_id, federation_posture, ipv4_prefix, ipv6_prefix, created_at, suspended \
             FROM coord_tenants ORDER BY created_at"
        )
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default();

        rows.into_iter()
            .filter_map(tenant_from_row)
            .collect()
    }

    pub async fn delete_tenant(&self, tenant_id: TenantId) -> Result<(), CoordError> {
        let tid_str = tenant_id.as_uuid().to_string();
        let mut tx = self.pool.begin().await.map_err(db)?;

        let child_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM coord_tenants WHERE parent_id = ?1"
        )
            .bind(&tid_str)
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;

        if child_count > 0 {
            return Err(CoordError::Protocol(
                "cannot delete tenant with children".into(),
            ));
        }

        let node_ids: Vec<i64> = sqlx::query_scalar(
            "SELECT id FROM coord_nodes WHERE tenant_id = ?1"
        )
            .bind(&tid_str)
            .fetch_all(&mut *tx)
            .await
            .map_err(db)?;

        sqlx::query("DELETE FROM coord_nodes WHERE tenant_id = ?1")
            .bind(&tid_str)
            .execute(&mut *tx)
            .await
            .map_err(db)?;

        sqlx::query("DELETE FROM coord_preauth_keys WHERE tenant_id = ?1")
            .bind(&tid_str)
            .execute(&mut *tx)
            .await
            .map_err(db)?;

        let result = sqlx::query("DELETE FROM coord_tenants WHERE id = ?1")
            .bind(&tid_str)
            .execute(&mut *tx)
            .await
            .map_err(db)?;

        if result.rows_affected() == 0 {
            return Err(CoordError::TenantNotFound(tenant_id));
        }

        tx.commit().await.map_err(db)?;

        for nid in node_ids {
            let _ = self.peer_tx.send(PeerEvent::NodeOffline {
                tenant_id,
                node_id: NodeId::new(nid),
            });
        }

        Ok(())
    }

    pub async fn get_child_tenants(&self, parent_id: TenantId) -> Vec<Tenant> {
        let rows = sqlx::query_as::<_, TenantRow>(
            "SELECT id, slug, parent_id, federation_posture, ipv4_prefix, ipv6_prefix, created_at, suspended \
             FROM coord_tenants WHERE parent_id = ?1 ORDER BY created_at"
        )
            .bind(parent_id.as_uuid().to_string())
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default();

        rows.into_iter()
            .filter_map(tenant_from_row)
            .collect()
    }

    pub async fn update_tenant_posture(
        &self,
        tenant_id: TenantId,
        posture: FederationPosture,
    ) -> Result<Tenant, CoordError> {
        let tid_str = tenant_id.as_uuid().to_string();

        sqlx::query("UPDATE coord_tenants SET federation_posture = ?1 WHERE id = ?2")
            .bind(posture.as_str())
            .bind(&tid_str)
            .execute(&self.pool)
            .await
            .map_err(db)?;

        self.get_tenant(tenant_id).await
            .ok_or(CoordError::TenantNotFound(tenant_id))
    }

    /// Set or clear the parent of a tenant. Returns the tenant and its previous parent.
    pub async fn set_tenant_parent(
        &self,
        tenant_id: TenantId,
        parent_id: Option<TenantId>,
    ) -> Result<(Tenant, Option<TenantId>), CoordError> {
        // BEGIN IMMEDIATE serializes parent changes, so two of them cannot build a cycle together.
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let tid_str = tenant_id.as_uuid().to_string();
        let current = sqlx::query_as::<_, TenantRow>("SELECT id, slug, parent_id, federation_posture, ipv4_prefix, ipv6_prefix, created_at, suspended FROM coord_tenants WHERE id = ?1")
            .bind(&tid_str)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?
            .and_then(tenant_from_row)
            .ok_or(CoordError::TenantNotFound(tenant_id))?;
        if let Some(pid) = parent_id {
            let parent = sqlx::query_as::<_, TenantRow>("SELECT id, slug, parent_id, federation_posture, ipv4_prefix, ipv6_prefix, created_at, suspended FROM coord_tenants WHERE id = ?1")
                .bind(pid.as_uuid().to_string())
                .fetch_optional(&mut *tx)
                .await
                .map_err(db)?
                .and_then(tenant_from_row);
            let has_children: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM coord_tenants WHERE parent_id = ?1)")
                .bind(&tid_str)
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
            crate::check_new_parent(tenant_id, pid, parent.as_ref(), has_children)?;
        }
        let row = sqlx::query_as::<_, TenantRow>("UPDATE coord_tenants SET parent_id = ?1 WHERE id = ?2 RETURNING id, slug, parent_id, federation_posture, ipv4_prefix, ipv6_prefix, created_at, suspended")
            .bind(parent_id.map(|p| p.as_uuid().to_string()))
            .bind(&tid_str)
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        let tenant = tenant_from_row(row).ok_or(CoordError::TenantNotFound(tenant_id))?;
        Ok((tenant, current.parent_id))
    }

    pub async fn set_tenant_suspended(
        &self,
        tenant_id: TenantId,
        suspended: bool,
    ) -> Result<Tenant, CoordError> {
        let result = sqlx::query("UPDATE coord_tenants SET suspended = ?1 WHERE id = ?2")
            .bind(suspended)
            .bind(tenant_id.as_uuid().to_string())
            .execute(&self.pool)
            .await
            .map_err(db)?;
        if result.rows_affected() == 0 {
            return Err(CoordError::TenantNotFound(tenant_id));
        }
        self.get_tenant(tenant_id).await
            .ok_or(CoordError::TenantNotFound(tenant_id))
    }

    pub async fn create_preauth_key(&self, tenant_id: TenantId, reusable: bool) -> Result<String, CoordError> {
        self.create_preauth_key_with(tenant_id, PreAuthKeyOptions { reusable, ..Default::default() })
            .await
            .map(|k| k.key)
    }

    pub async fn create_preauth_key_with(
        &self,
        tenant_id: TenantId,
        opts: PreAuthKeyOptions,
    ) -> Result<CreatedPreAuthKey, CoordError> {
        let key = generate_auth_key();
        let id = uuid::Uuid::new_v4();
        sqlx::query(
            "INSERT INTO coord_preauth_keys (key, key_prefix, id, tenant_id, reusable, ephemeral, expires_at, owner, tags) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
        )
            .bind(crate::hash_preauth_key(&key))
            .bind(coord_core::preauth_key_prefix(&key))
            .bind(id.to_string())
            .bind(tenant_id.as_uuid().to_string())
            .bind(opts.reusable)
            .bind(opts.ephemeral)
            .bind(opts.expires_at.map(format_datetime))
            .bind(&opts.owner)
            .bind(to_json(&opts.tags))
            .execute(&self.pool)
            .await
            .map_err(db)?;
        Ok(CreatedPreAuthKey { id, key, tenant_id, expires_at: opts.expires_at })
    }

    pub async fn list_preauth_keys(&self, tenant_id: TenantId) -> Vec<PreAuthKeyInfo> {
        type Row = (String, String, Option<String>, String, bool, bool, bool, Option<String>, String, Option<String>);
        let rows = sqlx::query_as::<_, Row>(
            "SELECT id, key_prefix, owner, tags, reusable, ephemeral, used, expires_at, created_at, revoked_at \
             FROM coord_preauth_keys WHERE tenant_id = ?1 ORDER BY created_at, id"
        )
            .bind(tenant_id.as_uuid().to_string())
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default();

        rows.into_iter()
            .filter_map(|(id, prefix, owner, tags, reusable, ephemeral, used, expires_at, created_at, revoked_at)| {
                Some(PreAuthKeyInfo {
                    id: uuid::Uuid::parse_str(&id).ok()?,
                    tenant_id,
                    prefix,
                    owner,
                    tags: from_json(&tags),
                    reusable,
                    ephemeral,
                    used,
                    expires_at: expires_at.as_deref().map(parse_datetime),
                    created_at: parse_datetime(&created_at),
                    revoked: revoked_at.is_some(),
                })
            })
            .collect()
    }

    pub async fn revoke_preauth_key(&self, tenant_id: TenantId, key_id: uuid::Uuid) -> Result<bool, CoordError> {
        let found: Option<String> = sqlx::query_scalar(
            "UPDATE coord_preauth_keys SET revoked_at = COALESCE(revoked_at, datetime('now')) \
             WHERE tenant_id = ?1 AND id = ?2 RETURNING id"
        )
            .bind(tenant_id.as_uuid().to_string())
            .bind(key_id.to_string())
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?;
        Ok(found.is_some())
    }

    pub async fn revoke_preauth_keys_by_owner(&self, tenant_id: TenantId, owner: &str) -> Result<u64, CoordError> {
        let result = sqlx::query(
            "UPDATE coord_preauth_keys SET revoked_at = datetime('now') \
             WHERE tenant_id = ?1 AND owner = ?2 AND revoked_at IS NULL"
        )
            .bind(tenant_id.as_uuid().to_string())
            .bind(owner)
            .execute(&self.pool)
            .await
            .map_err(db)?;
        Ok(result.rows_affected())
    }

    /// Tenant a pre-auth key belongs to, without validating or consuming it.
    pub async fn preauth_key_tenant(&self, key: &str) -> Option<TenantId> {
        let tid: String = sqlx::query_scalar("SELECT tenant_id FROM coord_preauth_keys WHERE key = ?1")
            .bind(crate::hash_preauth_key(key))
            .fetch_optional(&self.pool)
            .await
            .ok()??;
        uuid::Uuid::parse_str(&tid).ok().map(TenantId::new)
    }

    /// Atomically consumes a key: two registrations racing on a single-use key cannot both succeed.
    pub async fn validate_preauth_key(&self, key: &str) -> Option<PreAuthGrant> {
        let row: Option<(String, Option<String>, String, bool)> = sqlx::query_as(
            "UPDATE coord_preauth_keys SET used = 1 \
             WHERE key = ?1 \
               AND (used = 0 OR reusable = 1) \
               AND revoked_at IS NULL \
               AND (expires_at IS NULL OR expires_at > datetime('now')) \
             RETURNING tenant_id, owner, tags, ephemeral"
        )
            .bind(crate::hash_preauth_key(key))
            .fetch_optional(&self.pool)
            .await
            .ok()?;

        let (tenant_str, owner, tags, ephemeral) = row?;
        Some(PreAuthGrant {
            tenant_id: TenantId::new(uuid::Uuid::parse_str(&tenant_str).ok()?),
            owner,
            tags: from_json(&tags),
            ephemeral,
        })
    }

    pub async fn register_node(
        &self,
        tenant_id: TenantId,
        machine_key: [u8; 32],
        info: NodeInfo,
    ) -> Result<(NodeId, Ipv4Addr, u64), CoordError> {
        self.register_node_with(tenant_id, machine_key, info, NodeRegistration::default()).await
    }

    pub async fn register_node_with(
        &self,
        tenant_id: TenantId,
        machine_key: [u8; 32],
        info: NodeInfo,
        reg: NodeRegistration,
    ) -> Result<(NodeId, Ipv4Addr, u64), CoordError> {
        let tid_str = tenant_id.as_uuid().to_string();
        let endpoints_json = serde_json::to_string(&info.endpoints).unwrap();

        // BEGIN IMMEDIATE takes the database write lock up front, so the
        // lowest-free-address scan and the INSERT are atomic across connections.
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;

        let existing = sqlx::query_as::<_, (i64, String, String, i64, Option<String>, String, i16)>(
            "SELECT id, tenant_id, ipv4, session_generation, owner, tags, hold FROM coord_nodes WHERE machine_key = ?1"
        )
            .bind(&machine_key[..])
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;

        if let Some((id, existing_tenant_str, ip_str, old_generation, old_owner, old_tags, old_hold)) = existing {
            if existing_tenant_str != tid_str {
                return Err(CoordError::Protocol(
                    "machine key already registered to a different tenant".into(),
                ));
            }
            let new_gen = old_generation + 1;
            let hostname = tenant_unique_hostname(&mut tx, &tid_str, id, &info.hostname, &reg).await?;
            // A new identity (owner/tags) must not inherit approvals granted to the old one.
            let hold = coord_core::Hold::on_reregister(coord_core::Hold::from_i16(old_hold), reg.hold, old_owner == reg.owner);
            let identity_changed = old_owner != reg.owner || from_json(&old_tags) != reg.tags;
            sqlx::query(
                "UPDATE coord_nodes SET node_key = ?1, disco_key = ?2, hostname = ?3, os = ?4, \
                 endpoints = ?5, online = 1, last_seen = datetime('now'), session_generation = ?6, \
                 owner = ?7, tags = ?8, ephemeral = ?9, \
                 approved_routes = CASE WHEN ?10 THEN '[]' ELSE approved_routes END, hold = ?12 \
                 WHERE id = ?11"
            )
                .bind(&info.node_key)
                .bind(&info.disco_key)
                .bind(&hostname)
                .bind(&info.os)
                .bind(&endpoints_json)
                .bind(new_gen)
                .bind(&reg.owner)
                .bind(to_json(&reg.tags))
                .bind(reg.ephemeral)
                .bind(identity_changed)
                .bind(id)
                .bind(hold.as_i16())
                .execute(&mut *tx)
                .await
                .map_err(db)?;

            if let Some(routes) = reg.advertised_routes {
                sqlx::query("UPDATE coord_nodes SET advertised_routes = ?1 WHERE id = ?2")
                    .bind(to_json(&routes))
                    .bind(id)
                    .execute(&mut *tx)
                    .await
                    .map_err(db)?;
            }
            tx.commit().await.map_err(db)?;

            let ipv4: Ipv4Addr = ip_str.parse().map_err(|_| CoordError::Protocol("invalid stored IPv4".into()))?;
            let node_id = NodeId::new(id);
            let _ = self.peer_tx.send(PeerEvent::NodeUpdated {
                tenant_id,
                node_id,
            });
            return Ok((node_id, ipv4, crate::generation_from_db(new_gen)?));
        }

        let used: Vec<String> = sqlx::query_scalar("SELECT ipv4 FROM coord_nodes")
            .fetch_all(&mut *tx)
            .await
            .map_err(db)?;
        let new_ipv4 = crate::lowest_free_ipv4(used.iter().filter_map(|s| s.parse::<Ipv4Addr>().ok()))?;
        let new_ip_str = new_ipv4.to_string();
        let hostname = tenant_unique_hostname(&mut tx, &tid_str, -1, &info.hostname, &reg).await?;

        let row = sqlx::query_as::<_, (i64, i64)>(
            "INSERT INTO coord_nodes (tenant_id, machine_key, node_key, disco_key, stable_id, ipv4, hostname, os, endpoints, session_generation, \
                                      owner, tags, ephemeral, advertised_routes, hold) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, ?11, ?12, ?13, ?14) \
             RETURNING id, session_generation"
        )
            .bind(&tid_str)
            .bind(&machine_key[..])
            .bind(&info.node_key)
            .bind(&info.disco_key)
            .bind(generate_random_id())
            .bind(&new_ip_str)
            .bind(&hostname)
            .bind(&info.os)
            .bind(&endpoints_json)
            .bind(&reg.owner)
            .bind(to_json(&reg.tags))
            .bind(reg.ephemeral)
            .bind(to_json(&reg.advertised_routes.unwrap_or_default()))
            .bind(reg.hold.as_i16())
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;

        let (id, generation) = row;
        let node_id = NodeId::new(id);
        let _ = self.peer_tx.send(PeerEvent::NodeJoined {
            tenant_id,
            node_id,
        });

        Ok((node_id, new_ipv4, crate::generation_from_db(generation)?))
    }

    pub async fn rotate_node_key(
        &self,
        machine_key: &[u8; 32],
        _old_node_key: &[u8; 32],
        new_node_key: &[u8; 32],
    ) -> Result<(), CoordError> {
        let result = sqlx::query_as::<_, (i64, String)>(
            "UPDATE coord_nodes SET node_key = ?1 WHERE machine_key = ?2 RETURNING id, tenant_id"
        )
            .bind(&new_node_key[..])
            .bind(&machine_key[..])
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?;

        if let Some((id, tenant_str)) = result
            && let Ok(uuid) = uuid::Uuid::parse_str(&tenant_str) {
                let _ = self.peer_tx.send(PeerEvent::NodeUpdated {
                    tenant_id: TenantId::new(uuid),
                    node_id: NodeId::new(id),
                });
            }
        Ok(())
    }

    pub async fn update_endpoints(
        &self,
        node_id: NodeId,
        endpoints: Vec<String>,
        disco_key: Option<String>,
    ) -> Result<(), CoordError> {
        let mut updated = false;

        if !endpoints.is_empty() {
            sqlx::query("UPDATE coord_nodes SET endpoints = ?1 WHERE id = ?2")
                .bind(serde_json::to_string(&endpoints).unwrap())
                .bind(node_id.as_i64())
                .execute(&self.pool)
                .await
                .map_err(db)?;
            updated = true;
        }

        if let Some(dk) = disco_key {
            sqlx::query("UPDATE coord_nodes SET disco_key = ?1 WHERE id = ?2")
                .bind(&dk)
                .bind(node_id.as_i64())
                .execute(&self.pool)
                .await
                .map_err(db)?;
            updated = true;
        }

        if updated {
            let tenant_str: Option<String> = sqlx::query_scalar(
                "SELECT tenant_id FROM coord_nodes WHERE id = ?1"
            )
                .bind(node_id.as_i64())
                .fetch_optional(&self.pool)
                .await
                .map_err(db)?;

            if let Some(ts) = tenant_str
                && let Ok(uuid) = uuid::Uuid::parse_str(&ts) {
                    let _ = self.peer_tx.send(PeerEvent::NodeUpdated {
                        tenant_id: TenantId::new(uuid),
                        node_id,
                    });
                }
        }
        Ok(())
    }

    pub async fn get_node_by_machine_key(&self, machine_key: &[u8; 32]) -> Option<NodeId> {
        let id: Option<i64> = sqlx::query_scalar(
            "SELECT id FROM coord_nodes WHERE machine_key = ?1"
        )
            .bind(&machine_key[..])
            .fetch_optional(&self.pool)
            .await
            .ok()?;
        id.map(NodeId::new)
    }

    pub async fn get_node_by_node_key(&self, node_key: &[u8; 32]) -> Option<NodeId> {
        let id: Option<i64> = sqlx::query_scalar(
            "SELECT id FROM coord_nodes WHERE node_key = ?1 LIMIT 1"
        )
            .bind(&node_key[..])
            .fetch_optional(&self.pool)
            .await
            .ok()?;
        id.map(NodeId::new)
    }

    pub async fn get_peers(&self, tenant_id: TenantId, exclude_node: NodeId) -> Vec<PeerInfo> {
        let rows = sqlx::query_as::<_, PeerRow>(
            "SELECT id, node_key, machine_key, disco_key, endpoints, ipv4, hostname, online, last_seen, advertised_routes, approved_routes, owner \
             FROM coord_nodes WHERE tenant_id = ?1 AND id != ?2 AND hold = 0"
        )
            .bind(tenant_id.as_uuid().to_string())
            .bind(exclude_node.as_i64())
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default();

        rows.into_iter().map(peer_row_to_info).collect()
    }

    pub async fn get_peers_with_children(
        &self,
        tenant_id: TenantId,
        exclude_node: NodeId,
    ) -> Vec<PeerInfo> {
        let tid_str = tenant_id.as_uuid().to_string();
        let rows = sqlx::query_as::<_, PeerRow>(
            "SELECT n.id, n.node_key, n.machine_key, n.disco_key, n.endpoints, n.ipv4, n.hostname, n.online, n.last_seen, n.advertised_routes, n.approved_routes, n.owner \
             FROM coord_nodes n \
             WHERE n.id != ?2 AND n.hold = 0 AND ( \
                 n.tenant_id = ?1 \
                 OR n.tenant_id IN ( \
                     SELECT id FROM coord_tenants \
                     WHERE parent_id = ?1 AND federation_posture != 'closed' AND suspended = 0 \
                 ) \
             )"
        )
            .bind(&tid_str)
            .bind(exclude_node.as_i64())
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default();

        rows.into_iter().map(peer_row_to_info).collect()
    }

    pub async fn list_tenant_nodes(&self, tenant_id: TenantId) -> Vec<PeerInfo> {
        let rows = sqlx::query_as::<_, PeerRow>(
            "SELECT id, node_key, machine_key, disco_key, endpoints, ipv4, hostname, online, last_seen, advertised_routes, approved_routes, owner \
             FROM coord_nodes WHERE tenant_id = ?1"
        )
            .bind(tenant_id.as_uuid().to_string())
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default();

        rows.into_iter().map(peer_row_to_info).collect()
    }

    pub async fn list_nodes_for_tenant(&self, tenant_id: TenantId) -> Vec<NodeSummary> {
        let rows = sqlx::query_as::<_, SummaryRow>(
            "SELECT id, tenant_id, ipv4, stable_id, online, hostname, owner, tags, ephemeral, advertised_routes, approved_routes, hold, os, machine_key FROM coord_nodes WHERE tenant_id = ?1 ORDER BY id"
        )
            .bind(tenant_id.as_uuid().to_string())
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default();

        rows.into_iter().filter_map(summary_row_to_summary).collect()
    }

    pub async fn get_node_info(&self, node_id: NodeId) -> Option<NodeDetail> {
        // Split into two queries to stay within sqlx tuple size limits
        let basic = sqlx::query_as::<_, (String, String, String, bool)>(
            "SELECT tenant_id, ipv4, stable_id, online FROM coord_nodes WHERE id = ?1"
        )
            .bind(node_id.as_i64())
            .fetch_optional(&self.pool)
            .await
            .ok()??;

        let info_row = sqlx::query_as::<_, (Vec<u8>, Vec<u8>, Option<String>, String, String, String)>(
            "SELECT node_key, machine_key, disco_key, endpoints, hostname, os FROM coord_nodes WHERE id = ?1"
        )
            .bind(node_id.as_i64())
            .fetch_optional(&self.pool)
            .await
            .ok()??;

        let attrs_row = sqlx::query_as::<_, (Option<String>, String, bool, String, String, i16)>(
            "SELECT owner, tags, ephemeral, advertised_routes, approved_routes, hold FROM coord_nodes WHERE id = ?1"
        )
            .bind(node_id.as_i64())
            .fetch_optional(&self.pool)
            .await
            .ok()??;

        let (tenant_str, ip_str, stable_id, online) = basic;
        let (node_key, machine_key, disco_key, endpoints_str, hostname, os) = info_row;
        let ipv4: Ipv4Addr = ip_str.parse().ok()?;
        let endpoints: Vec<String> = serde_json::from_str(&endpoints_str).unwrap_or_default();

        Some(NodeDetail {
            tenant_id: TenantId::new(uuid::Uuid::parse_str(&tenant_str).ok()?),
            ipv4,
            stable_id,
            info: NodeInfo {
                node_key,
                machine_key,
                disco_key,
                endpoints,
                hostname,
                os,
                ipv4: None,
                ipv6: None,
            },
            online,
            attrs: attrs_from_parts(attrs_row),
        })
    }

    pub async fn get_node_ipv4(&self, node_id: NodeId) -> Option<Ipv4Addr> {
        let ip_str: Option<String> = sqlx::query_scalar(
            "SELECT ipv4 FROM coord_nodes WHERE id = ?1"
        )
            .bind(node_id.as_i64())
            .fetch_optional(&self.pool)
            .await
            .ok()?;
        ip_str.and_then(|s| s.parse().ok())
    }

    pub async fn get_node_stable_id(&self, node_id: NodeId) -> Option<String> {
        sqlx::query_scalar("SELECT stable_id FROM coord_nodes WHERE id = ?1")
            .bind(node_id.as_i64())
            .fetch_optional(&self.pool)
            .await
            .ok()?
    }

    pub async fn get_node_tenant(&self, node_id: NodeId) -> Option<TenantId> {
        let tenant_str: Option<String> = sqlx::query_scalar(
            "SELECT tenant_id FROM coord_nodes WHERE id = ?1"
        )
            .bind(node_id.as_i64())
            .fetch_optional(&self.pool)
            .await
            .ok()?;

        tenant_str
            .and_then(|s| uuid::Uuid::parse_str(&s).ok())
            .map(TenantId::new)
    }

    pub async fn list_nodes(&self) -> Vec<NodeSummary> {
        let rows = sqlx::query_as::<_, SummaryRow>(
            "SELECT id, tenant_id, ipv4, stable_id, online, hostname, owner, tags, ephemeral, advertised_routes, approved_routes, hold, os, machine_key FROM coord_nodes ORDER BY id"
        )
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default();

        rows.into_iter().filter_map(summary_row_to_summary).collect()
    }

    pub async fn delete_node(&self, node_id: NodeId) -> Result<TenantId, CoordError> {
        let tenant_str: Option<String> = sqlx::query_scalar(
            "DELETE FROM coord_nodes WHERE id = ?1 RETURNING tenant_id"
        )
            .bind(node_id.as_i64())
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?;

        match tenant_str {
            Some(s) => {
                let uuid = uuid::Uuid::parse_str(&s)
                    .map_err(|_| CoordError::Protocol("invalid stored UUID".into()))?;
                let tid = TenantId::new(uuid);
                let _ = self.peer_tx.send(PeerEvent::NodeOffline { tenant_id: tid, node_id });
                Ok(tid)
            }
            None => Err(CoordError::Protocol("node not found".into())),
        }
    }

    pub async fn rename_node(&self, node_id: NodeId, new_name: String) -> Result<(), CoordError> {
        // BEGIN IMMEDIATE makes the uniqueness check and the update atomic.
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let Some((tenant_str, owner, tags)) = sqlx::query_as::<_, (String, Option<String>, String)>(
            "SELECT tenant_id, owner, tags FROM coord_nodes WHERE id = ?1"
        )
            .bind(node_id.as_i64())
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?
        else {
            return Err(CoordError::Protocol("node not found".into()));
        };
        let reg = NodeRegistration { owner, tags: from_json(&tags), ..Default::default() };
        let name = tenant_unique_hostname(&mut tx, &tenant_str, node_id.as_i64(), &new_name, &reg).await?;
        sqlx::query("UPDATE coord_nodes SET hostname = ?1 WHERE id = ?2")
            .bind(&name)
            .bind(node_id.as_i64())
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        if let Ok(uuid) = uuid::Uuid::parse_str(&tenant_str) {
            let _ = self.peer_tx.send(PeerEvent::NodeUpdated { tenant_id: TenantId::new(uuid), node_id });
        }
        Ok(())
    }

    pub async fn set_node_online(&self, node_id: NodeId, online: bool) -> Result<(), CoordError> {
        let result: Option<String> = sqlx::query_scalar(
            "UPDATE coord_nodes SET online = ?1, last_seen = datetime('now') WHERE id = ?2 RETURNING tenant_id"
        )
            .bind(online)
            .bind(node_id.as_i64())
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?;

        if let Some(tenant_str) = result
            && let Ok(uuid) = uuid::Uuid::parse_str(&tenant_str) {
                if online {
                    let _ = self.peer_tx.send(PeerEvent::NodeUpdated {
                        tenant_id: TenantId::new(uuid),
                        node_id,
                    });
                } else {
                    let _ = self.peer_tx.send(PeerEvent::NodeOffline {
                        tenant_id: TenantId::new(uuid),
                        node_id,
                    });
                }
            }
        Ok(())
    }

    pub async fn set_node_offline_if_current(&self, node_id: NodeId, generation: u64) -> Result<(), CoordError> {
        let result: Option<String> = sqlx::query_scalar(
            "UPDATE coord_nodes SET online = 0, last_seen = datetime('now') \
             WHERE id = ?1 AND session_generation = ?2 \
             RETURNING tenant_id"
        )
            .bind(node_id.as_i64())
            .bind(crate::generation_to_db(generation)?)
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?;

        if let Some(tenant_str) = result
            && let Ok(uuid) = uuid::Uuid::parse_str(&tenant_str) {
                let _ = self.peer_tx.send(PeerEvent::NodeOffline {
                    tenant_id: TenantId::new(uuid),
                    node_id,
                });
            }
        Ok(())
    }

    /// Starts a map session of a known node: online, new generation. Returns the generation.
    pub async fn begin_node_session(&self, node_id: NodeId) -> Result<u64, CoordError> {
        let row: Option<(String, i64)> = sqlx::query_as(
            "UPDATE coord_nodes SET online = 1, last_seen = datetime('now'), \
             session_generation = session_generation + 1 \
             WHERE id = ?1 RETURNING tenant_id, session_generation"
        )
            .bind(node_id.as_i64())
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?;
        let Some((tenant_str, generation)) = row else {
            return Err(CoordError::Protocol(format!("node {node_id} not found")));
        };
        if let Ok(uuid) = uuid::Uuid::parse_str(&tenant_str) {
            let _ = self.peer_tx.send(PeerEvent::NodeUpdated {
                tenant_id: TenantId::new(uuid),
                node_id,
            });
        }
        crate::generation_from_db(generation)
    }

    pub async fn set_advertised_routes(&self, node_id: NodeId, routes: Vec<String>) -> Result<bool, CoordError> {
        self.set_routes_column(node_id, "advertised_routes", routes).await
    }

    pub async fn set_approved_routes(&self, node_id: NodeId, routes: Vec<String>) -> Result<bool, CoordError> {
        self.set_routes_column(node_id, "approved_routes", routes).await
    }

    async fn set_routes_column(&self, node_id: NodeId, column: &'static str, routes: Vec<String>) -> Result<bool, CoordError> {
        let json = to_json(&routes);
        // Only rows whose value actually changes are returned, so `None` means
        // either "no such node" or "unchanged" — disambiguate below.
        let sql = format!(
            "UPDATE coord_nodes SET {column} = ?1 WHERE id = ?2 AND {column} != ?1 RETURNING tenant_id"
        );
        let changed: Option<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
            .bind(&json)
            .bind(node_id.as_i64())
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?;
        match changed {
            Some(tenant_str) => {
                if let Ok(uuid) = uuid::Uuid::parse_str(&tenant_str) {
                    let _ = self.peer_tx.send(PeerEvent::NodeUpdated { tenant_id: TenantId::new(uuid), node_id });
                }
                Ok(true)
            }
            None => {
                if self.get_node_tenant(node_id).await.is_none() {
                    return Err(CoordError::Protocol("node not found".into()));
                }
                Ok(false)
            }
        }
    }

    /// Moves a node from the hold `from` to the hold `to`. False when its hold is not `from`.
    pub async fn set_node_hold(&self, node_id: NodeId, from: coord_core::Hold, to: coord_core::Hold) -> Result<bool, CoordError> {
        let changed: Option<String> = sqlx::query_scalar(
            "UPDATE coord_nodes SET hold = ?1 WHERE id = ?2 AND hold = ?3 AND hold <> ?1 RETURNING tenant_id"
        )
            .bind(to.as_i16())
            .bind(node_id.as_i64())
            .bind(from.as_i16())
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?;
        match changed {
            Some(tenant_str) => {
                if let Ok(uuid) = uuid::Uuid::parse_str(&tenant_str) {
                    let _ = self.peer_tx.send(PeerEvent::NodeUpdated { tenant_id: TenantId::new(uuid), node_id });
                }
                Ok(true)
            }
            None => {
                if self.get_node_tenant(node_id).await.is_none() {
                    return Err(CoordError::Protocol("node not found".into()));
                }
                Ok(false)
            }
        }
    }

    pub async fn delete_nodes_by_owner(&self, tenant_id: TenantId, owner: &str) -> Result<Vec<NodeId>, CoordError> {
        let mut ids: Vec<i64> = sqlx::query_scalar(
            "DELETE FROM coord_nodes WHERE tenant_id = ?1 AND owner = ?2 RETURNING id"
        )
            .bind(tenant_id.as_uuid().to_string())
            .bind(owner)
            .fetch_all(&self.pool)
            .await
            .map_err(db)?;
        ids.sort_unstable();
        let ids: Vec<NodeId> = ids.into_iter().map(NodeId::new).collect();
        for node_id in &ids {
            let _ = self.peer_tx.send(PeerEvent::NodeOffline { tenant_id, node_id: *node_id });
        }
        Ok(ids)
    }

    pub async fn delete_stale_ephemeral_nodes(
        &self,
        max_offline: Duration,
    ) -> Result<Vec<(TenantId, NodeId)>, CoordError> {
        let cutoff = format_datetime(clock::now() - max_offline);
        let mut rows: Vec<(i64, String)> = sqlx::query_as(
            "DELETE FROM coord_nodes WHERE ephemeral = 1 AND online = 0 AND last_seen <= ?1 \
             RETURNING id, tenant_id"
        )
            .bind(cutoff)
            .fetch_all(&self.pool)
            .await
            .map_err(db)?;
        rows.sort_unstable_by_key(|(id, _)| *id);
        let removed: Vec<(TenantId, NodeId)> = rows
            .into_iter()
            .filter_map(|(id, t)| Some((TenantId::new(uuid::Uuid::parse_str(&t).ok()?), NodeId::new(id))))
            .collect();
        for (tenant_id, node_id) in &removed {
            let _ = self.peer_tx.send(PeerEvent::NodeOffline { tenant_id: *tenant_id, node_id: *node_id });
        }
        Ok(removed)
    }

    pub async fn get_tenant_route_snapshot(
        &self,
        tenant_id: TenantId,
    ) -> Result<crate::memory::TenantRouteSnapshot, CoordError> {
        let tid_str = tenant_id.as_uuid().to_string();
        let mut tx = self.pool.begin().await.map_err(db)?;

        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM coord_tenants WHERE id = ?1"
        )
            .bind(&tid_str)
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;

        if count == 0 {
            return Err(CoordError::TenantNotFound(tenant_id));
        }

        let child_rows = sqlx::query_as::<_, TenantRow>(
            "SELECT id, slug, parent_id, federation_posture, ipv4_prefix, ipv6_prefix, created_at, suspended \
             FROM coord_tenants WHERE parent_id = ?1 ORDER BY created_at"
        )
            .bind(&tid_str)
            .fetch_all(&mut *tx)
            .await
            .unwrap_or_default();

        let children: Vec<Tenant> = child_rows.into_iter()
            .filter_map(tenant_from_row)
            .collect();

        let own_nodes = Self::list_nodes_in_tx(&mut tx, tenant_id).await;

        let mut visible_child_nodes = Vec::new();
        for child in &children {
            if child.visible_to_parent() {
                let child_nodes = Self::list_nodes_in_tx(&mut tx, child.id).await;
                visible_child_nodes.push((child.id, child.slug.clone(), child_nodes));
            }
        }

        tx.commit().await.map_err(db)?;

        Ok(crate::memory::TenantRouteSnapshot {
            children,
            own_nodes,
            visible_child_nodes,
        })
    }

    async fn list_nodes_in_tx(
        tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
        tenant_id: TenantId,
    ) -> Vec<PeerInfo> {
        let rows = sqlx::query_as::<_, PeerRow>(
            "SELECT id, node_key, machine_key, disco_key, endpoints, ipv4, hostname, online, last_seen, advertised_routes, approved_routes, owner \
             FROM coord_nodes WHERE tenant_id = ?1"
        )
            .bind(tenant_id.as_uuid().to_string())
            .fetch_all(&mut **tx)
            .await
            .unwrap_or_default();

        rows.into_iter().map(peer_row_to_info).collect()
    }
}

impl std::fmt::Debug for SqliteStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SqliteStore").finish()
    }
}

type TenantRow = (String, String, Option<String>, String, String, String, String, bool);

fn tenant_from_row(
    (id_str, slug, parent_str, posture_str, ipv4_prefix, ipv6_prefix, created_at_str, suspended): TenantRow,
) -> Option<Tenant> {
    Some(Tenant {
        id: TenantId::new(uuid::Uuid::parse_str(&id_str).ok()?),
        slug,
        parent_id: parent_str.and_then(|s| uuid::Uuid::parse_str(&s).ok()).map(TenantId::new),
        federation_posture: parse_posture(&posture_str),
        ipv4_prefix,
        ipv6_prefix,
        created_at: parse_datetime(&created_at_str),
        suspended,
    })
}

fn parse_posture(s: &str) -> FederationPosture {
    s.parse().unwrap_or_else(|_| {
        tracing::warn!(value = s, "unknown federation posture, defaulting to Closed");
        FederationPosture::Closed
    })
}

type PeerRow = (i64, Vec<u8>, Vec<u8>, Option<String>, String, String, String, bool, String, String, String, Option<String>);
type SummaryRow = (i64, String, String, String, bool, String, Option<String>, String, bool, String, String, i16, String, Vec<u8>);

fn to_json(v: &[String]) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "[]".into())
}

/// [`crate::unique_hostname`] against the other nodes of `tenant` (all but node `except`).
/// Call it inside a `BEGIN IMMEDIATE` transaction.
async fn tenant_unique_hostname(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    tenant: &str,
    except: i64,
    desired: &str,
    reg: &NodeRegistration,
) -> Result<String, CoordError> {
    let others: Vec<(i64, String)> = sqlx::query_as("SELECT id, hostname FROM coord_nodes WHERE tenant_id = ?1 AND id <> ?2")
        .bind(tenant)
        .bind(except)
        .fetch_all(&mut **tx)
        .await
        .map_err(db)?;
    let is_gateway = coord_core::is_gateway_identity(reg.owner.as_deref(), &reg.tags);
    Ok(crate::unique_hostname(desired, is_gateway, others.iter().map(|(id, h)| (*id, h.as_str()))))
}

fn from_json(s: &str) -> Vec<String> {
    serde_json::from_str(s).unwrap_or_default()
}

fn attrs_from_parts((owner, tags, ephemeral, advertised, approved, hold): (Option<String>, String, bool, String, String, i16)) -> NodeAttrs {
    NodeAttrs {
        owner,
        tags: from_json(&tags),
        ephemeral,
        advertised_routes: from_json(&advertised),
        approved_routes: from_json(&approved),
        hold: coord_core::Hold::from_i16(hold),
    }
}

fn peer_row_to_info(
    (id, node_key, machine_key, disco_key, endpoints_str, ip_str, hostname, online, last_seen_str, advertised, approved, owner): PeerRow,
) -> PeerInfo {
    let endpoints: Vec<String> = serde_json::from_str(&endpoints_str).unwrap_or_default();
    let (addresses, allowed_ips, primary_routes) =
        coord_core::node_route_sets(&ip_str, &from_json(&advertised), &from_json(&approved));
    PeerInfo {
        node_id: NodeId::new(id),
        node_key,
        machine_key,
        disco_key,
        endpoints,
        addresses,
        allowed_ips,
        primary_routes,
        hostname,
        derp_region: Some(1),
        online,
        last_seen: Some(parse_datetime(&last_seen_str)),
        owner,
    }
}

fn summary_row_to_summary(
    (id, tenant_str, ip_str, stable_id, online, hostname, owner, tags, ephemeral, advertised, approved, hold, os, machine_key): SummaryRow,
) -> Option<NodeSummary> {
    let ipv4: Ipv4Addr = ip_str.parse().ok()?;
    Some(NodeSummary {
        id: NodeId::new(id),
        tenant_id: TenantId::new(uuid::Uuid::parse_str(&tenant_str).ok()?),
        ipv4,
        stable_id,
        online,
        hostname,
        os,
        machine_key,
        attrs: attrs_from_parts((owner, tags, ephemeral, advertised, approved, hold)),
    })
}

/// Same text format as SQLite's `datetime('now')`, so string comparison works.
fn format_datetime(dt: OffsetDateTime) -> String {
    clock::to_sqlite(dt)
}

fn parse_datetime(s: &str) -> OffsetDateTime {
    clock::parse_sqlite(s).unwrap_or_else(clock::now)
}
