use std::net::Ipv4Addr;
use sqlx::SqlitePool;
use tokio::sync::broadcast;

use coord_core::{
    CoordError, CreatedPreAuthKey, FederationPosture, NodeAttrs, NodeDetail, NodeId, NodeInfo,
    NodeRegistration, NodeSummary, PeerInfo, PreAuthGrant, PreAuthKeyInfo, PreAuthKeyOptions,
    StorageError, Tenant, TenantId,
};
use crate::memory::PeerEvent;
use crate::{generate_auth_key, generate_random_id};

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

impl SqliteStore {
    pub async fn new(pool: SqlitePool) -> Result<Self, StorageError> {
        sqlx::migrate!("../../migrations_sqlite")
            .run(&pool)
            .await
            .map_err(db_migrate)?;

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

        if let Some(ref pid_str) = parent_str {
            let parent_row = sqlx::query_as::<_, (String, Option<String>)>(
                "SELECT id, parent_id FROM coord_tenants WHERE id = ?1"
            )
                .bind(pid_str)
                .fetch_optional(&self.pool)
                .await
                .map_err(db)?;

            match parent_row {
                None => return Err(CoordError::TenantNotFound(parent_id.unwrap())),
                Some((_, Some(_))) => {
                    return Err(CoordError::Protocol(
                        "multi-level hierarchy not supported: parent is itself a child".into(),
                    ));
                }
                Some((_, None)) => {}
            }
        }

        let existing = sqlx::query_as::<_, (String,)>(
            "SELECT slug FROM coord_tenants WHERE slug = ?1"
        )
            .bind(&slug)
            .fetch_optional(&self.pool)
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
            .execute(&self.pool)
            .await
            .map_err(db)?;

        Ok(Tenant {
            id,
            slug,
            parent_id,
            federation_posture,
            ipv4_prefix: coord_core::DEFAULT_IPV4_PREFIX.into(),
            ipv6_prefix: coord_core::DEFAULT_IPV6_PREFIX.into(),
            created_at: chrono::Utc::now(),
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

    pub async fn get_tenant_configs(&self, tenant_id: TenantId) -> Vec<(String, serde_json::Value)> {
        let rows: Vec<(String, String)> = sqlx::query_as("SELECT kind, value FROM coord_tenant_config WHERE tenant_id = ?1")
            .bind(tenant_id.as_uuid().to_string())
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default();
        rows.into_iter().filter_map(|(k, v)| Some((k, serde_json::from_str(&v).ok()?))).collect()
    }

    pub async fn list_tenant_configs(&self) -> Vec<(TenantId, String, serde_json::Value)> {
        let rows: Vec<(String, String, String)> = sqlx::query_as("SELECT tenant_id, kind, value FROM coord_tenant_config")
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default();
        rows.into_iter()
            .filter_map(|(t, k, v)| Some((TenantId::new(t.parse().ok()?), k, serde_json::from_str(&v).ok()?)))
            .collect()
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

    pub async fn sign_in_start(&self, id: &str, machine_key: &[u8; 32], hostname: &str, os: &str) -> Result<(), CoordError> {
        let now = crate::now_secs();
        let machine = hex::encode(machine_key);
        sqlx::query("DELETE FROM coord_sign_ins WHERE machine_key = ?1 OR expires_at <= ?2")
            .bind(&machine)
            .bind(now)
            .execute(&self.pool)
            .await
            .map_err(db)?;
        sqlx::query("INSERT INTO coord_sign_ins (id, machine_key, hostname, os, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)")
            .bind(id)
            .bind(&machine)
            .bind(hostname)
            .bind(os)
            .bind(now + coord_core::signin::SIGN_IN_TTL_SECS)
            .execute(&self.pool)
            .await
            .map_err(db)?;
        // Bound the table: drop the oldest beyond the cap
        sqlx::query(
            "DELETE FROM coord_sign_ins WHERE id IN \
             (SELECT id FROM coord_sign_ins ORDER BY expires_at DESC LIMIT -1 OFFSET ?1)"
        )
            .bind(coord_core::signin::MAX_PENDING_SIGN_INS)
            .execute(&self.pool)
            .await
            .map_err(db)?;
        Ok(())
    }

    pub async fn sign_in_get(&self, id: &str) -> Option<coord_core::PendingSignIn> {
        let row: Option<(String, String, String, Option<String>)> = sqlx::query_as(
            "SELECT machine_key, hostname, os, decision FROM coord_sign_ins WHERE id = ?1 AND expires_at > ?2"
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

    pub async fn get_owner_lock(&self, tenant_id: TenantId, owner: &str) -> Option<coord_core::OwnerLock> {
        let row: Option<String> = sqlx::query_scalar("SELECT lock FROM coord_owner_locks WHERE tenant_id = ?1 AND owner = ?2")
            .bind(tenant_id.as_uuid().to_string())
            .bind(owner)
            .fetch_optional(&self.pool)
            .await
            .ok()
            .flatten();
        row.and_then(|v| serde_json::from_str(&v).ok())
    }

    pub async fn set_owner_lock(&self, tenant_id: TenantId, owner: &str, lock: Option<coord_core::OwnerLock>) -> Result<(), CoordError> {
        if self.get_tenant(tenant_id).await.is_none() {
            return Err(CoordError::TenantNotFound(tenant_id));
        }
        match lock {
            Some(l) => sqlx::query(
                "INSERT INTO coord_owner_locks (tenant_id, owner, lock) VALUES (?1, ?2, ?3) \
                 ON CONFLICT (tenant_id, owner) DO UPDATE SET lock = excluded.lock, updated_at = datetime('now')"
            )
                .bind(tenant_id.as_uuid().to_string())
                .bind(owner)
                .bind(serde_json::to_string(&l).unwrap_or_default())
                .execute(&self.pool)
                .await
                .map_err(db)?,
            None => sqlx::query("DELETE FROM coord_owner_locks WHERE tenant_id = ?1 AND owner = ?2")
                .bind(tenant_id.as_uuid().to_string())
                .bind(owner)
                .execute(&self.pool)
                .await
                .map_err(db)?,
        };
        Ok(())
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
            "INSERT INTO coord_preauth_keys (key, id, tenant_id, reusable, ephemeral, expires_at, owner, tags) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
        )
            .bind(&key)
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
            "SELECT id, key, owner, tags, reusable, ephemeral, used, expires_at, created_at, revoked_at \
             FROM coord_preauth_keys WHERE tenant_id = ?1 ORDER BY created_at, id"
        )
            .bind(tenant_id.as_uuid().to_string())
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default();

        rows.into_iter()
            .filter_map(|(id, key, owner, tags, reusable, ephemeral, used, expires_at, created_at, revoked_at)| {
                Some(PreAuthKeyInfo {
                    id: uuid::Uuid::parse_str(&id).ok()?,
                    tenant_id,
                    prefix: coord_core::preauth_key_prefix(&key),
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

    /// Atomically consume a key: the conditional UPDATE means two registrations
    /// racing on a single-use key cannot both succeed.
    /// Tenant a pre-auth key belongs to, without validating or consuming it.
    pub async fn preauth_key_tenant(&self, key: &str) -> Option<TenantId> {
        let tid: String = sqlx::query_scalar("SELECT tenant_id FROM coord_preauth_keys WHERE key = ?1")
            .bind(key)
            .fetch_optional(&self.pool)
            .await
            .ok()??;
        uuid::Uuid::parse_str(&tid).ok().map(TenantId::new)
    }

    pub async fn validate_preauth_key(&self, key: &str) -> Option<PreAuthGrant> {
        let row: Option<(String, Option<String>, String, bool)> = sqlx::query_as(
            "UPDATE coord_preauth_keys SET used = 1 \
             WHERE key = ?1 \
               AND (used = 0 OR reusable = 1) \
               AND revoked_at IS NULL \
               AND (expires_at IS NULL OR expires_at > datetime('now')) \
             RETURNING tenant_id, owner, tags, ephemeral"
        )
            .bind(key)
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

        let existing = sqlx::query_as::<_, (i64, String, String, i64, Option<String>, String)>(
            "SELECT id, tenant_id, ipv4, session_generation, owner, tags FROM coord_nodes WHERE machine_key = ?1"
        )
            .bind(&machine_key[..])
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;

        if let Some((id, existing_tenant_str, ip_str, old_generation, old_owner, old_tags)) = existing {
            if existing_tenant_str != tid_str {
                return Err(CoordError::Protocol(
                    "machine key already registered to a different tenant".into(),
                ));
            }
            let new_gen = old_generation + 1;
            // A new identity (owner/tags) must not inherit approvals granted to the old one.
            let identity_changed = old_owner != reg.owner || from_json(&old_tags) != reg.tags;
            sqlx::query(
                "UPDATE coord_nodes SET node_key = ?1, disco_key = ?2, hostname = ?3, os = ?4, \
                 endpoints = ?5, online = 1, last_seen = datetime('now'), session_generation = ?6, \
                 owner = ?7, tags = ?8, ephemeral = ?9, \
                 approved_routes = CASE WHEN ?10 THEN '[]' ELSE approved_routes END \
                 WHERE id = ?11"
            )
                .bind(&info.node_key)
                .bind(&info.disco_key)
                .bind(&info.hostname)
                .bind(&info.os)
                .bind(&endpoints_json)
                .bind(new_gen)
                .bind(&reg.owner)
                .bind(to_json(&reg.tags))
                .bind(reg.ephemeral)
                .bind(identity_changed)
                .bind(id)
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
            return Ok((node_id, ipv4, new_gen as u64));
        }

        let used: Vec<String> = sqlx::query_scalar("SELECT ipv4 FROM coord_nodes")
            .fetch_all(&mut *tx)
            .await
            .map_err(db)?;
        let new_ipv4 = crate::lowest_free_ipv4(used.iter().filter_map(|s| s.parse::<Ipv4Addr>().ok()))?;
        let new_ip_str = new_ipv4.to_string();

        let row = sqlx::query_as::<_, (i64, i64)>(
            "INSERT INTO coord_nodes (tenant_id, machine_key, node_key, disco_key, stable_id, ipv4, hostname, os, endpoints, session_generation, \
                                      owner, tags, ephemeral, advertised_routes) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, ?11, ?12, ?13) \
             RETURNING id, session_generation"
        )
            .bind(&tid_str)
            .bind(&machine_key[..])
            .bind(&info.node_key)
            .bind(&info.disco_key)
            .bind(generate_random_id())
            .bind(&new_ip_str)
            .bind(&info.hostname)
            .bind(&info.os)
            .bind(&endpoints_json)
            .bind(&reg.owner)
            .bind(to_json(&reg.tags))
            .bind(reg.ephemeral)
            .bind(to_json(&reg.advertised_routes.unwrap_or_default()))
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

        Ok((node_id, new_ipv4, generation as u64))
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

        if let Some((id, tenant_str)) = result {
            if let Ok(uuid) = uuid::Uuid::parse_str(&tenant_str) {
                let _ = self.peer_tx.send(PeerEvent::NodeUpdated {
                    tenant_id: TenantId::new(uuid),
                    node_id: NodeId::new(id),
                });
            }
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

            if let Some(ts) = tenant_str {
                if let Ok(uuid) = uuid::Uuid::parse_str(&ts) {
                    let _ = self.peer_tx.send(PeerEvent::NodeUpdated {
                        tenant_id: TenantId::new(uuid),
                        node_id,
                    });
                }
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
             FROM coord_nodes WHERE tenant_id = ?1 AND id != ?2"
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
             WHERE n.id != ?2 AND ( \
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
            "SELECT id, tenant_id, ipv4, stable_id, online, hostname, owner, tags, ephemeral, advertised_routes, approved_routes FROM coord_nodes WHERE tenant_id = ?1 ORDER BY id"
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

        let attrs_row = sqlx::query_as::<_, (Option<String>, String, bool, String, String)>(
            "SELECT owner, tags, ephemeral, advertised_routes, approved_routes FROM coord_nodes WHERE id = ?1"
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
            "SELECT id, tenant_id, ipv4, stable_id, online, hostname, owner, tags, ephemeral, advertised_routes, approved_routes FROM coord_nodes ORDER BY id"
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
        let result = sqlx::query_as::<_, (String,)>(
            "UPDATE coord_nodes SET hostname = ?1 WHERE id = ?2 RETURNING tenant_id"
        )
            .bind(&new_name)
            .bind(node_id.as_i64())
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?;

        match result {
            Some((tenant_str,)) => {
                if let Ok(uuid) = uuid::Uuid::parse_str(&tenant_str) {
                    let _ = self.peer_tx.send(PeerEvent::NodeUpdated {
                        tenant_id: TenantId::new(uuid),
                        node_id,
                    });
                }
                Ok(())
            }
            None => Err(CoordError::Protocol("node not found".into())),
        }
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

        if let Some(tenant_str) = result {
            if let Ok(uuid) = uuid::Uuid::parse_str(&tenant_str) {
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
            .bind(generation as i64)
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?;

        if let Some(tenant_str) = result {
            if let Ok(uuid) = uuid::Uuid::parse_str(&tenant_str) {
                let _ = self.peer_tx.send(PeerEvent::NodeOffline {
                    tenant_id: TenantId::new(uuid),
                    node_id,
                });
            }
        }
        Ok(())
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
        let changed: Option<String> = sqlx::query_scalar(&sql)
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
        max_offline: chrono::Duration,
    ) -> Result<Vec<(TenantId, NodeId)>, CoordError> {
        let cutoff = format_datetime(chrono::Utc::now() - max_offline);
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
type SummaryRow = (i64, String, String, String, bool, String, Option<String>, String, bool, String, String);

fn to_json(v: &[String]) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "[]".into())
}

fn from_json(s: &str) -> Vec<String> {
    serde_json::from_str(s).unwrap_or_default()
}

fn attrs_from_parts((owner, tags, ephemeral, advertised, approved): (Option<String>, String, bool, String, String)) -> NodeAttrs {
    NodeAttrs {
        owner,
        tags: from_json(&tags),
        ephemeral,
        advertised_routes: from_json(&advertised),
        approved_routes: from_json(&approved),
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
    (id, tenant_str, ip_str, stable_id, online, hostname, owner, tags, ephemeral, advertised, approved): SummaryRow,
) -> Option<NodeSummary> {
    let ipv4: Ipv4Addr = ip_str.parse().ok()?;
    Some(NodeSummary {
        id: NodeId::new(id),
        tenant_id: TenantId::new(uuid::Uuid::parse_str(&tenant_str).ok()?),
        ipv4,
        stable_id,
        online,
        hostname,
        attrs: attrs_from_parts((owner, tags, ephemeral, advertised, approved)),
    })
}

/// Same text format as SQLite's `datetime('now')`, so string comparison works.
fn format_datetime(dt: chrono::DateTime<chrono::Utc>) -> String {
    dt.format("%Y-%m-%d %H:%M:%S").to_string()
}

fn parse_datetime(s: &str) -> chrono::DateTime<chrono::Utc> {
    chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f"))
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(s, "%+"))
        .map(|dt| dt.and_utc())
        .unwrap_or_else(|_| chrono::Utc::now())
}
