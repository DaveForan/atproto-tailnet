use std::net::Ipv4Addr;
use sqlx::PgPool;
use tokio::sync::broadcast;

use coord_core::{
    CoordError, CreatedPreAuthKey, FederationPosture, NodeAttrs, NodeDetail, NodeId, NodeInfo,
    NodeRegistration, NodeSummary, PeerInfo, PreAuthGrant, PreAuthKeyInfo, PreAuthKeyOptions,
    StorageError, Tenant, TenantId,
};
use chrono::{DateTime, Utc};
use serde_json::Value as Json;
use crate::memory::PeerEvent;
use crate::RemoteEvent;
use crate::{generate_auth_key, generate_random_id};

/// pg_advisory_xact_lock key serializing node registration / IPv4 allocation.
const IPV4_ALLOC_LOCK_KEY: i64 = 0x636f_6f72_6449_5034; // "coordIP4"

/// First key of the two-key advisory locks serializing machine-lock updates
/// (the second is a hash of tenant and owner).
const OWNER_LOCK_LOCK_CLASS: i32 = 0x6f6c_636b; // "olck"

fn decode_owner_lock(tenant_id: TenantId, row: Option<Json>) -> coord_core::LockRead {
    match row {
        None => coord_core::LockRead::Unlocked,
        Some(v) => match serde_json::from_value(v) {
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

pub struct PgStore {
    pool: PgPool,
    peer_tx: broadcast::Sender<PeerEvent>,
    /// Events that other replicas published (ADR-0034).
    remote_tx: broadcast::Sender<RemoteEvent>,
    /// Random id of this process, so it can ignore its own notifications.
    replica: String,
}

/// PostgreSQL NOTIFY channel shared by all coordinator replicas.
const EVENT_CHANNEL: &str = "coord_events";

/// One notification: `<replica>|<kind>|<tenant or sign-in id>|<node id>`.
fn encode_peer(replica: &str, event: PeerEvent) -> String {
    let (kind, tenant_id, node_id) = match event {
        PeerEvent::NodeJoined { tenant_id, node_id } => ('j', tenant_id, node_id),
        PeerEvent::NodeUpdated { tenant_id, node_id } => ('u', tenant_id, node_id),
        PeerEvent::NodeOffline { tenant_id, node_id } => ('o', tenant_id, node_id),
    };
    format!("{replica}|{kind}|{}|{}", tenant_id.as_uuid(), node_id.as_i64())
}

fn encode_remote(replica: &str, event: &RemoteEvent) -> String {
    match event {
        RemoteEvent::TenantChanged(t) => format!("{replica}|t|{}|", t.as_uuid()),
        RemoteEvent::SignInDecided(id) => format!("{replica}|d|{id}|"),
        // Local only; never published
        RemoteEvent::Resync => String::new(),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Decoded {
    Peer(PeerEvent),
    Remote(RemoteEvent),
}

/// Parse a notification. `None` for our own notifications and for anything malformed.
fn decode_event(payload: &str, own_replica: &str) -> Option<Decoded> {
    let mut parts = payload.splitn(4, '|');
    let (replica, kind, subject, arg) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
    if replica == own_replica {
        return None;
    }
    if kind == "d" {
        return Some(Decoded::Remote(RemoteEvent::SignInDecided(subject.to_string())));
    }
    // The nil id means "every tenant" inside a process; a notification never
    // carries it (that would rebuild every stream on every replica).
    let tenant_id = TenantId::new(subject.parse().ok().filter(|u: &uuid::Uuid| !u.is_nil())?);
    if kind == "t" {
        return Some(Decoded::Remote(RemoteEvent::TenantChanged(tenant_id)));
    }
    let node_id = NodeId::new(arg.parse().ok().filter(|n: &i64| *n > 0)?);
    Some(Decoded::Peer(match kind {
        "j" => PeerEvent::NodeJoined { tenant_id, node_id },
        "u" => PeerEvent::NodeUpdated { tenant_id, node_id },
        "o" => PeerEvent::NodeOffline { tenant_id, node_id },
        _ => return None,
    }))
}

/// Feed notifications of other replicas into this process's channels. Runs
/// until the process ends; reconnects when the connection drops.
///
/// NOTIFY is not durable: whatever is published while this process has no
/// LISTEN connection is lost. Every time the connection comes back, a
/// `RemoteEvent::Resync` tells the process to rebuild its caches and send
/// every live stream a full snapshot.
async fn listen_for_events(
    pool: PgPool,
    replica: String,
    peer_tx: broadcast::Sender<PeerEvent>,
    remote_tx: broadcast::Sender<RemoteEvent>,
) {
    // Set once a connection was lost: the next connection starts with a resync.
    let mut missed = false;
    loop {
        let listener = async {
            let mut l = sqlx::postgres::PgListener::connect_with(&pool).await?;
            l.listen(EVENT_CHANNEL).await?;
            Ok::<_, sqlx::Error>(l)
        };
        let mut l = match listener.await {
            Ok(l) => l,
            Err(e) => {
                tracing::warn!(error = %e, "event listener could not connect");
                missed = true;
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                continue;
            }
        };
        if std::mem::take(&mut missed) {
            tracing::info!("event listener reconnected: resyncing");
            let _ = remote_tx.send(RemoteEvent::Resync);
        }
        loop {
            // `try_recv` (unlike `recv`) reports a lost connection as `Ok(None)`
            // after re-establishing it and its LISTEN, so the gap is not silent.
            match l.try_recv().await {
                Ok(Some(n)) => match decode_event(n.payload(), &replica) {
                    Some(Decoded::Peer(e)) => {
                        let _ = peer_tx.send(e);
                    }
                    Some(Decoded::Remote(e)) => {
                        let _ = remote_tx.send(e);
                    }
                    None => {}
                },
                Ok(None) => {
                    tracing::warn!("event listener lost its connection and reconnected: resyncing");
                    let _ = remote_tx.send(RemoteEvent::Resync);
                }
                Err(e) => {
                    tracing::warn!(error = %e, "event listener lost its connection");
                    missed = true;
                    break;
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
}

/// Schema migrations embedded in this binary.
static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../../migrations");

#[derive(Debug)]
struct SchemaError(String);

impl std::fmt::Display for SchemaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SchemaError {}

impl PgStore {
    /// Connect and apply pending migrations (control processes).
    pub async fn new(pool: PgPool) -> Result<Self, StorageError> {
        MIGRATOR.run(&pool).await.map_err(StorageError::new)?;
        Ok(Self::start(pool))
    }

    /// The newest migration version this binary expects in the database.
    pub fn required_schema_version() -> i64 {
        MIGRATOR.iter().map(|m| m.version).max().unwrap_or(0)
    }

    /// Connect without migrating (relay processes, which may run with a
    /// least-privilege role that cannot create anything). Fails with a clear
    /// error when the schema is behind this binary: start a control process
    /// (which migrates) first.
    pub async fn new_verified(pool: PgPool) -> Result<Self, StorageError> {
        let required = Self::required_schema_version();
        let applied: Result<(Option<i64>, i64), sqlx::Error> =
            sqlx::query_as("SELECT MAX(version) FILTER (WHERE success), COUNT(*) FILTER (WHERE NOT success) FROM _sqlx_migrations")
                .fetch_one(&pool)
                .await;
        let (applied, failed) = match applied {
            Ok(r) => r,
            Err(e) => {
                return Err(StorageError::new(SchemaError(format!(
                    "cannot read the schema version (_sqlx_migrations): {e}; this process does not migrate \
                     (COORD_ROLE=relay): start a control process first so it creates the schema"
                ))));
            }
        };
        if failed > 0 {
            return Err(StorageError::new(SchemaError(format!(
                "the database has {failed} failed migration(s); fix them with a control process first"
            ))));
        }
        let applied = applied.unwrap_or(0);
        if applied < required {
            return Err(StorageError::new(SchemaError(format!(
                "database schema is behind this binary (applied version {applied}, needs {required}); \
                 this process does not migrate (COORD_ROLE=relay): start a control process first so it applies the migrations"
            ))));
        }
        Ok(Self::start(pool))
    }

    fn start(pool: PgPool) -> Self {
        let (peer_tx, _) = broadcast::channel(crate::PEER_EVENT_CHANNEL_CAPACITY);
        let (remote_tx, _) = broadcast::channel(crate::PEER_EVENT_CHANNEL_CAPACITY);
        let replica = generate_random_id();
        tokio::spawn(listen_for_events(pool.clone(), replica.clone(), peer_tx.clone(), remote_tx.clone()));
        Self { pool, peer_tx, remote_tx, replica }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<PeerEvent> {
        self.peer_tx.subscribe()
    }

    pub fn subscribe_remote(&self) -> broadcast::Receiver<RemoteEvent> {
        self.remote_tx.subscribe()
    }

    /// Deliver a peer event to this process and to the other replicas.
    async fn emit(&self, event: PeerEvent) {
        let _ = self.peer_tx.send(event);
        self.notify(encode_peer(&self.replica, event)).await;
    }

    pub async fn publish(&self, event: RemoteEvent) {
        if event == RemoteEvent::Resync {
            return;
        }
        self.notify(encode_remote(&self.replica, &event)).await;
    }

    /// Best effort: a lost notification delays an update on another replica
    /// until that device's next keep-alive snapshot.
    async fn notify(&self, payload: String) {
        if let Err(e) = sqlx::query("SELECT pg_notify($1, $2)")
            .bind(EVENT_CHANNEL)
            .bind(payload)
            .execute(&self.pool)
            .await
        {
            tracing::warn!(error = %e, "failed to publish an event to other replicas");
        }
    }

    pub async fn create_tenant(
        &self,
        slug: String,
        parent_id: Option<TenantId>,
        posture: Option<FederationPosture>,
    ) -> Result<Tenant, CoordError> {
        let id = TenantId::generate();
        let parent_uuid = parent_id.map(|p| *p.as_uuid());
        let federation_posture = posture.unwrap_or_default();

        if let Some(pid) = parent_uuid {
            let parent_row: Option<(uuid::Uuid, Option<uuid::Uuid>)> = sqlx::query_as(
                "SELECT id, parent_id FROM coord_tenants WHERE id = $1"
            )
                .bind(pid)
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
                Some((_, None)) => { /* ok: parent is a root tenant */ }
            }
        }

        sqlx::query(
            "INSERT INTO coord_tenants (id, slug, parent_id, federation_posture) VALUES ($1, $2, $3, $4)"
        )
            .bind(id.as_uuid())
            .bind(&slug)
            .bind(parent_uuid)
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
             FROM coord_tenants WHERE id = $1"
        )
            .bind(tenant_id.as_uuid())
            .fetch_optional(&self.pool)
            .await
            .ok()??;

        Some(tenant_from_row(row))
    }

    pub async fn get_tenant_access(&self, tenant_id: TenantId) -> coord_core::TenantAccess {
        let row: Option<Json> = sqlx::query_scalar("SELECT access FROM coord_tenant_access WHERE tenant_id = $1")
            .bind(tenant_id.as_uuid())
            .fetch_optional(&self.pool)
            .await
            .ok()
            .flatten();
        row.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
    }

    pub async fn set_tenant_access(&self, tenant_id: TenantId, access: coord_core::TenantAccess) -> Result<(), CoordError> {
        if self.get_tenant(tenant_id).await.is_none() {
            return Err(CoordError::TenantNotFound(tenant_id));
        }
        let value = serde_json::to_value(&access).unwrap_or_default();
        sqlx::query(
            "INSERT INTO coord_tenant_access (tenant_id, access) VALUES ($1, $2) \
             ON CONFLICT (tenant_id) DO UPDATE SET access = EXCLUDED.access, updated_at = NOW()"
        )
            .bind(tenant_id.as_uuid())
            .bind(value)
            .execute(&self.pool)
            .await
            .map_err(db)?;
        Ok(())
    }

    pub async fn get_tenant_dns(&self, tenant_id: TenantId) -> coord_core::TenantDns {
        let row: Option<Json> = sqlx::query_scalar("SELECT dns FROM coord_tenant_dns WHERE tenant_id = $1")
            .bind(tenant_id.as_uuid())
            .fetch_optional(&self.pool)
            .await
            .ok()
            .flatten();
        row.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
    }

    pub async fn set_tenant_dns(&self, tenant_id: TenantId, dns: coord_core::TenantDns) -> Result<(), CoordError> {
        if self.get_tenant(tenant_id).await.is_none() {
            return Err(CoordError::TenantNotFound(tenant_id));
        }
        sqlx::query(
            "INSERT INTO coord_tenant_dns (tenant_id, dns) VALUES ($1, $2) \
             ON CONFLICT (tenant_id) DO UPDATE SET dns = EXCLUDED.dns, updated_at = NOW()"
        )
            .bind(tenant_id.as_uuid())
            .bind(serde_json::to_value(&dns).unwrap_or_default())
            .execute(&self.pool)
            .await
            .map_err(db)?;
        Ok(())
    }

    pub async fn get_tenant_configs(&self, tenant_id: TenantId) -> Result<Vec<(String, serde_json::Value)>, CoordError> {
        let rows: Vec<(String, Json)> = sqlx::query_as("SELECT kind, value FROM coord_tenant_config WHERE tenant_id = $1")
            .bind(tenant_id.as_uuid())
            .fetch_all(&self.pool)
            .await
            .map_err(db)?;
        Ok(rows)
    }

    pub async fn list_tenant_configs(&self) -> Result<Vec<(TenantId, String, serde_json::Value)>, CoordError> {
        let rows: Vec<(uuid::Uuid, String, Json)> = sqlx::query_as("SELECT tenant_id, kind, value FROM coord_tenant_config")
            .fetch_all(&self.pool)
            .await
            .map_err(db)?;
        Ok(rows.into_iter().map(|(t, k, v)| (TenantId::new(t), k, v)).collect())
    }

    pub async fn set_tenant_config(&self, tenant_id: TenantId, kind: &str, value: Option<serde_json::Value>) -> Result<(), CoordError> {
        if self.get_tenant(tenant_id).await.is_none() {
            return Err(CoordError::TenantNotFound(tenant_id));
        }
        match value {
            Some(v) => sqlx::query(
                "INSERT INTO coord_tenant_config (tenant_id, kind, value) VALUES ($1, $2, $3) \
                 ON CONFLICT (tenant_id, kind) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()"
            )
                .bind(tenant_id.as_uuid())
                .bind(kind)
                .bind(v)
                .execute(&self.pool)
                .await
                .map_err(db)?,
            None => sqlx::query("DELETE FROM coord_tenant_config WHERE tenant_id = $1 AND kind = $2")
                .bind(tenant_id.as_uuid())
                .bind(kind)
                .execute(&self.pool)
                .await
                .map_err(db)?,
        };
        Ok(())
    }

    pub async fn sign_in_start(&self, id: &str, machine_key: &[u8; 32], hostname: &str, os: &str, requester_ip: Option<&str>) -> Result<(), CoordError> {
        let now = crate::now_secs();
        let machine = hex::encode(machine_key);
        sqlx::query("DELETE FROM coord_sign_ins WHERE machine_key = $1 OR expires_at <= $2")
            .bind(&machine)
            .bind(now)
            .execute(&self.pool)
            .await
            .map_err(db)?;
        sqlx::query("INSERT INTO coord_sign_ins (id, machine_key, hostname, os, expires_at, requester_ip, requested_at) VALUES ($1, $2, $3, $4, $5, $6, $7)")
            .bind(id)
            .bind(&machine)
            .bind(hostname)
            .bind(os)
            .bind(now + coord_core::signin::SIGN_IN_TTL_SECS)
            .bind(requester_ip)
            .bind(now)
            .execute(&self.pool)
            .await
            .map_err(db)?;
        // Bound the table: drop the oldest beyond the cap
        sqlx::query(
            "DELETE FROM coord_sign_ins WHERE id IN \
             (SELECT id FROM coord_sign_ins ORDER BY expires_at DESC OFFSET $1)"
        )
            .bind(coord_core::signin::MAX_PENDING_SIGN_INS)
            .execute(&self.pool)
            .await
            .map_err(db)?;
        Ok(())
    }

    pub async fn sign_in_get(&self, id: &str) -> Option<coord_core::PendingSignIn> {
        let row: Option<crate::SignInRow> = sqlx::query_as(
            &format!("SELECT {} FROM coord_sign_ins WHERE id = $1 AND expires_at > $2", crate::SIGN_IN_COLUMNS)
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
        sqlx::query("UPDATE coord_sign_ins SET decision = $1 WHERE id = $2 AND decision IS NULL AND expires_at > $3")
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
            "DELETE FROM coord_sign_ins WHERE id = $1 AND decision IS NOT NULL RETURNING decision"
        )
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .ok()
            .flatten();
        row.flatten().and_then(|d| serde_json::from_str(&d).ok())
    }

    pub async fn relay_heartbeat(&self, relay: &coord_core::RelayInfo) -> Result<(), CoordError> {
        sqlx::query(
            "INSERT INTO coord_relays (region_id, hostname, stun_port, last_seen) VALUES ($1, $2, $3, $4) \
             ON CONFLICT (region_id) DO UPDATE SET hostname = EXCLUDED.hostname, stun_port = EXCLUDED.stun_port, last_seen = EXCLUDED.last_seen"
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
            "SELECT region_id, hostname, stun_port FROM coord_relays WHERE last_seen >= $1"
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
        let row: Option<uuid::Uuid> = sqlx::query_scalar(
            "UPDATE coord_nodes SET home_derp = $1 WHERE id = $2 AND home_derp IS DISTINCT FROM $1 RETURNING tenant_id"
        )
            .bind(region)
            .bind(node_id.as_i64())
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?;
        let Some(tenant_uuid) = row else { return Ok(false) };
        let tenant_id = TenantId::new(tenant_uuid);
        self.emit(PeerEvent::NodeUpdated { tenant_id, node_id }).await;
        Ok(true)
    }

    pub async fn home_relays(&self, node_ids: &[NodeId]) -> std::collections::HashMap<NodeId, i32> {
        let ids: Vec<i64> = node_ids.iter().map(|n| n.as_i64()).collect();
        let rows: Vec<(i64, i32)> = sqlx::query_as("SELECT id, home_derp FROM coord_nodes WHERE id = ANY($1) AND home_derp IS NOT NULL")
            .bind(&ids)
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default();
        rows.into_iter().map(|(id, region)| (NodeId::new(id), region)).collect()
    }

    pub async fn list_owner_locks(&self) -> Vec<(TenantId, String, coord_core::OwnerLock)> {
        let rows: Vec<(uuid::Uuid, String, Json)> = match sqlx::query_as("SELECT tenant_id, owner, lock FROM coord_owner_locks")
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
            .filter_map(|(t, o, l)| match serde_json::from_value(l) {
                Ok(lock) => Some((TenantId::new(t), o, lock)),
                Err(e) => {
                    tracing::error!(tenant = %t, error = %e, "malformed machine lock skipped in listing");
                    None
                }
            })
            .collect()
    }

    pub async fn get_owner_lock(&self, tenant_id: TenantId, owner: &str) -> Result<coord_core::LockRead, CoordError> {
        let row: Option<Json> = sqlx::query_scalar("SELECT lock FROM coord_owner_locks WHERE tenant_id = $1 AND owner = $2")
            .bind(tenant_id.as_uuid())
            .bind(owner)
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?;
        Ok(decode_owner_lock(tenant_id, row))
    }

    /// Serialized per (tenant, owner) by a transaction-scoped advisory lock
    /// (so the first insert is covered too, where `FOR UPDATE` has no row).
    pub async fn update_owner_lock<R, F>(&self, tenant_id: TenantId, owner: &str, f: F) -> Result<R, CoordError>
    where
        F: FnOnce(coord_core::LockRead) -> (coord_core::LockWrite, R),
    {
        let mut tx = self.pool.begin().await.map_err(db)?;
        sqlx::query("SELECT pg_advisory_xact_lock($1, hashtext($2))")
            .bind(OWNER_LOCK_LOCK_CLASS)
            .bind(format!("{}|{}", tenant_id.as_uuid(), owner))
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        let tenant: Option<uuid::Uuid> = sqlx::query_scalar("SELECT id FROM coord_tenants WHERE id = $1")
            .bind(tenant_id.as_uuid())
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;
        if tenant.is_none() {
            return Err(CoordError::TenantNotFound(tenant_id));
        }
        let row: Option<Json> = sqlx::query_scalar(
            "SELECT lock FROM coord_owner_locks WHERE tenant_id = $1 AND owner = $2 FOR UPDATE"
        )
            .bind(tenant_id.as_uuid())
            .bind(owner)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;
        let (write, out) = f(decode_owner_lock(tenant_id, row));
        match write {
            coord_core::LockWrite::Keep => {}
            coord_core::LockWrite::Set(l) => {
                let value = serde_json::to_value(&l).map_err(|e| CoordError::Protocol(e.to_string()))?;
                sqlx::query(
                    "INSERT INTO coord_owner_locks (tenant_id, owner, lock) VALUES ($1, $2, $3) \
                     ON CONFLICT (tenant_id, owner) DO UPDATE SET lock = EXCLUDED.lock, updated_at = NOW()"
                )
                    .bind(tenant_id.as_uuid())
                    .bind(owner)
                    .bind(value)
                    .execute(&mut *tx)
                    .await
                    .map_err(db)?;
            }
            coord_core::LockWrite::Remove => {
                sqlx::query("DELETE FROM coord_owner_locks WHERE tenant_id = $1 AND owner = $2")
                    .bind(tenant_id.as_uuid())
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
            .map(tenant_from_row)
            .collect()
    }

    pub async fn delete_tenant(&self, tenant_id: TenantId) -> Result<(), CoordError> {
        let mut tx = self.pool.begin().await.map_err(db)?;

        let child_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM coord_tenants WHERE parent_id = $1"
        )
            .bind(tenant_id.as_uuid())
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;

        if child_count > 0 {
            return Err(CoordError::Protocol(
                "cannot delete tenant with children".into(),
            ));
        }

        let node_ids: Vec<i64> = sqlx::query_scalar(
            "SELECT id FROM coord_nodes WHERE tenant_id = $1"
        )
            .bind(tenant_id.as_uuid())
            .fetch_all(&mut *tx)
            .await
            .map_err(db)?;

        sqlx::query("DELETE FROM coord_nodes WHERE tenant_id = $1")
            .bind(tenant_id.as_uuid())
            .execute(&mut *tx)
            .await
            .map_err(db)?;

        sqlx::query("DELETE FROM coord_preauth_keys WHERE tenant_id = $1")
            .bind(tenant_id.as_uuid())
            .execute(&mut *tx)
            .await
            .map_err(db)?;

        let result = sqlx::query("DELETE FROM coord_tenants WHERE id = $1")
            .bind(tenant_id.as_uuid())
            .execute(&mut *tx)
            .await
            .map_err(db)?;

        if result.rows_affected() == 0 {
            return Err(CoordError::TenantNotFound(tenant_id));
        }

        tx.commit().await.map_err(db)?;

        for nid in node_ids {
            self.emit(PeerEvent::NodeOffline {
                tenant_id,
                node_id: NodeId::new(nid),
            }).await;
        }

        Ok(())
    }

    pub async fn get_child_tenants(&self, parent_id: TenantId) -> Vec<Tenant> {
        let rows = sqlx::query_as::<_, TenantRow>(
            "SELECT id, slug, parent_id, federation_posture, ipv4_prefix, ipv6_prefix, created_at, suspended \
             FROM coord_tenants WHERE parent_id = $1 ORDER BY created_at"
        )
            .bind(parent_id.as_uuid())
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default();

        rows.into_iter()
            .map(tenant_from_row)
            .collect()
    }

    pub async fn update_tenant_posture(
        &self,
        tenant_id: TenantId,
        posture: FederationPosture,
    ) -> Result<Tenant, CoordError> {
        let posture_str = match posture {
            FederationPosture::Open => "open",
            FederationPosture::Selective => "selective",
            FederationPosture::Closed => "closed",
        };
        let row = sqlx::query_as::<_, TenantRow>(
            "UPDATE coord_tenants SET federation_posture = $1 WHERE id = $2 \
             RETURNING id, slug, parent_id, federation_posture, ipv4_prefix, ipv6_prefix, created_at, suspended"
        )
            .bind(posture_str)
            .bind(tenant_id.as_uuid())
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?;

        match row {
            Some(r) => Ok(tenant_from_row(r)),
            None => Err(CoordError::TenantNotFound(tenant_id)),
        }
    }

    pub async fn set_tenant_suspended(
        &self,
        tenant_id: TenantId,
        suspended: bool,
    ) -> Result<Tenant, CoordError> {
        let row = sqlx::query_as::<_, TenantRow>(
            "UPDATE coord_tenants SET suspended = $1 WHERE id = $2 \
             RETURNING id, slug, parent_id, federation_posture, ipv4_prefix, ipv6_prefix, created_at, suspended"
        )
            .bind(suspended)
            .bind(tenant_id.as_uuid())
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?;
        row.map(tenant_from_row).ok_or(CoordError::TenantNotFound(tenant_id))
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
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)"
        )
            .bind(crate::hash_preauth_key(&key))
            .bind(coord_core::preauth_key_prefix(&key))
            .bind(id)
            .bind(tenant_id.as_uuid())
            .bind(opts.reusable)
            .bind(opts.ephemeral)
            .bind(opts.expires_at)
            .bind(&opts.owner)
            .bind(to_json(&opts.tags))
            .execute(&self.pool)
            .await
            .map_err(db)?;
        Ok(CreatedPreAuthKey { id, key, tenant_id, expires_at: opts.expires_at })
    }

    pub async fn list_preauth_keys(&self, tenant_id: TenantId) -> Vec<PreAuthKeyInfo> {
        type Row = (uuid::Uuid, String, Option<String>, Json, bool, bool, bool, Option<DateTime<Utc>>, DateTime<Utc>, Option<DateTime<Utc>>);
        let rows = sqlx::query_as::<_, Row>(
            "SELECT id, key_prefix, owner, tags, reusable, ephemeral, used, expires_at, created_at, revoked_at \
             FROM coord_preauth_keys WHERE tenant_id = $1 ORDER BY created_at, id"
        )
            .bind(tenant_id.as_uuid())
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default();

        rows.into_iter()
            .map(|(id, prefix, owner, tags, reusable, ephemeral, used, expires_at, created_at, revoked_at)| PreAuthKeyInfo {
                id,
                tenant_id,
                prefix,
                owner,
                tags: from_json(tags),
                reusable,
                ephemeral,
                used,
                expires_at,
                created_at,
                revoked: revoked_at.is_some(),
            })
            .collect()
    }

    pub async fn revoke_preauth_key(&self, tenant_id: TenantId, key_id: uuid::Uuid) -> Result<bool, CoordError> {
        let found: Option<uuid::Uuid> = sqlx::query_scalar(
            "UPDATE coord_preauth_keys SET revoked_at = COALESCE(revoked_at, NOW()) \
             WHERE tenant_id = $1 AND id = $2 RETURNING id"
        )
            .bind(tenant_id.as_uuid())
            .bind(key_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?;
        Ok(found.is_some())
    }

    pub async fn revoke_preauth_keys_by_owner(&self, tenant_id: TenantId, owner: &str) -> Result<u64, CoordError> {
        let result = sqlx::query(
            "UPDATE coord_preauth_keys SET revoked_at = NOW() \
             WHERE tenant_id = $1 AND owner = $2 AND revoked_at IS NULL"
        )
            .bind(tenant_id.as_uuid())
            .bind(owner)
            .execute(&self.pool)
            .await
            .map_err(db)?;
        Ok(result.rows_affected())
    }

    /// Atomically consume a key: the conditional UPDATE (row-locked by Postgres)
    /// means two registrations racing on a single-use key cannot both succeed.
    /// Tenant a pre-auth key belongs to, without validating or consuming it.
    pub async fn preauth_key_tenant(&self, key: &str) -> Option<TenantId> {
        sqlx::query_scalar::<_, uuid::Uuid>("SELECT tenant_id FROM coord_preauth_keys WHERE key = $1")
            .bind(crate::hash_preauth_key(key))
            .fetch_optional(&self.pool)
            .await
            .ok()?
            .map(TenantId::new)
    }

    pub async fn validate_preauth_key(&self, key: &str) -> Option<PreAuthGrant> {
        let row: Option<(uuid::Uuid, Option<String>, Json, bool)> = sqlx::query_as(
            "UPDATE coord_preauth_keys SET used = TRUE \
             WHERE key = $1 \
               AND (used = FALSE OR reusable = TRUE) \
               AND revoked_at IS NULL \
               AND (expires_at IS NULL OR expires_at > NOW()) \
             RETURNING tenant_id, owner, tags, ephemeral"
        )
            .bind(crate::hash_preauth_key(key))
            .fetch_optional(&self.pool)
            .await
            .ok()?;

        let (tenant_uuid, owner, tags, ephemeral) = row?;
        Some(PreAuthGrant {
            tenant_id: TenantId::new(tenant_uuid),
            owner,
            tags: from_json(tags),
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
        let endpoints_json = serde_json::to_value(&info.endpoints).unwrap();

        // All registrations serialize on one transaction-scoped advisory lock so
        // the lowest-free-address scan and the INSERT are atomic with respect
        // to each other (and a machine key can't be inserted twice).
        let mut tx = self.pool.begin().await.map_err(db)?;
        sqlx::query("SELECT pg_advisory_xact_lock($1)")
            .bind(IPV4_ALLOC_LOCK_KEY)
            .execute(&mut *tx)
            .await
            .map_err(db)?;

        let existing = sqlx::query_as::<_, (i64, uuid::Uuid, String, i64, Option<String>, Json)>(
            "SELECT id, tenant_id, ipv4, session_generation, owner, tags FROM coord_nodes WHERE machine_key = $1"
        )
            .bind(&machine_key[..])
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;

        if let Some((id, existing_tenant_uuid, ip_str, old_generation, old_owner, old_tags)) = existing {
            let existing_tenant = TenantId::new(existing_tenant_uuid);
            if existing_tenant != tenant_id {
                return Err(CoordError::Protocol(
                    "machine key already registered to a different tenant".into(),
                ));
            }
            let new_gen = old_generation + 1;
            // A new identity (owner/tags) must not inherit approvals granted to the old one.
            let identity_changed = old_owner != reg.owner || from_json(old_tags) != reg.tags;
            sqlx::query(
                "UPDATE coord_nodes SET node_key = $1, disco_key = $2, hostname = $3, os = $4, \
                 endpoints = $5, online = TRUE, last_seen = NOW(), session_generation = $6, \
                 owner = $7, tags = $8, ephemeral = $9, \
                 approved_routes = CASE WHEN $10 THEN '[]'::jsonb ELSE approved_routes END \
                 WHERE id = $11"
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
                sqlx::query("UPDATE coord_nodes SET advertised_routes = $1 WHERE id = $2")
                    .bind(to_json(&routes))
                    .bind(id)
                    .execute(&mut *tx)
                    .await
                    .map_err(db)?;
            }
            tx.commit().await.map_err(db)?;

            let ipv4: Ipv4Addr = ip_str.parse().map_err(|_| CoordError::Protocol("invalid stored IPv4".into()))?;
            let node_id = NodeId::new(id);
            self.emit(PeerEvent::NodeUpdated {
                tenant_id,
                node_id,
            }).await;
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
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $11, $12, $13) \
             RETURNING id, session_generation"
        )
            .bind(tenant_id.as_uuid())
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
        self.emit(PeerEvent::NodeJoined {
            tenant_id,
            node_id,
        }).await;

        Ok((node_id, new_ipv4, generation as u64))
    }

    pub async fn rotate_node_key(
        &self,
        machine_key: &[u8; 32],
        _old_node_key: &[u8; 32],
        new_node_key: &[u8; 32],
    ) -> Result<(), CoordError> {
        let result = sqlx::query_as::<_, (i64, uuid::Uuid)>(
            "UPDATE coord_nodes SET node_key = $1 WHERE machine_key = $2 RETURNING id, tenant_id"
        )
            .bind(&new_node_key[..])
            .bind(&machine_key[..])
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?;

        if let Some((id, tenant_uuid)) = result {
            self.emit(PeerEvent::NodeUpdated {
                tenant_id: TenantId::new(tenant_uuid),
                node_id: NodeId::new(id),
            }).await;
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
            sqlx::query("UPDATE coord_nodes SET endpoints = $1 WHERE id = $2")
                .bind(serde_json::to_value(&endpoints).unwrap())
                .bind(node_id.as_i64())
                .execute(&self.pool)
                .await
                .map_err(db)?;
            updated = true;
        }

        if let Some(dk) = disco_key {
            sqlx::query("UPDATE coord_nodes SET disco_key = $1 WHERE id = $2")
                .bind(&dk)
                .bind(node_id.as_i64())
                .execute(&self.pool)
                .await
                .map_err(db)?;
            updated = true;
        }

        if updated {
            let tenant_uuid: Option<uuid::Uuid> = sqlx::query_scalar(
                "SELECT tenant_id FROM coord_nodes WHERE id = $1"
            )
                .bind(node_id.as_i64())
                .fetch_optional(&self.pool)
                .await
                .map_err(db)?;

            if let Some(tenant_uuid) = tenant_uuid {
                self.emit(PeerEvent::NodeUpdated {
                    tenant_id: TenantId::new(tenant_uuid),
                    node_id,
                }).await;
            }
        }
        Ok(())
    }

    pub async fn get_node_by_machine_key(&self, machine_key: &[u8; 32]) -> Option<NodeId> {
        let id: Option<i64> = sqlx::query_scalar(
            "SELECT id FROM coord_nodes WHERE machine_key = $1"
        )
            .bind(&machine_key[..])
            .fetch_optional(&self.pool)
            .await
            .ok()?;
        id.map(NodeId::new)
    }

    pub async fn get_node_by_node_key(&self, node_key: &[u8; 32]) -> Option<NodeId> {
        let id: Option<i64> = sqlx::query_scalar(
            "SELECT id FROM coord_nodes WHERE node_key = $1 LIMIT 1"
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
             FROM coord_nodes WHERE tenant_id = $1 AND id != $2"
        )
            .bind(tenant_id.as_uuid())
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
        let rows = sqlx::query_as::<_, PeerRow>(
            "SELECT n.id, n.node_key, n.machine_key, n.disco_key, n.endpoints, n.ipv4, n.hostname, n.online, n.last_seen, n.advertised_routes, n.approved_routes, n.owner \
             FROM coord_nodes n \
             WHERE n.id != $2 AND ( \
                 n.tenant_id = $1 \
                 OR n.tenant_id IN ( \
                     SELECT id FROM coord_tenants \
                     WHERE parent_id = $1 AND federation_posture != 'closed' AND NOT suspended \
                 ) \
             )"
        )
            .bind(tenant_id.as_uuid())
            .bind(exclude_node.as_i64())
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default();

        rows.into_iter().map(peer_row_to_info).collect()
    }

    pub async fn list_tenant_nodes(&self, tenant_id: TenantId) -> Vec<PeerInfo> {
        let rows = sqlx::query_as::<_, PeerRow>(
            "SELECT id, node_key, machine_key, disco_key, endpoints, ipv4, hostname, online, last_seen, advertised_routes, approved_routes, owner \
             FROM coord_nodes WHERE tenant_id = $1"
        )
            .bind(tenant_id.as_uuid())
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default();

        rows.into_iter().map(peer_row_to_info).collect()
    }

    pub async fn list_nodes_for_tenant(&self, tenant_id: TenantId) -> Vec<NodeSummary> {
        let rows = sqlx::query_as::<_, SummaryRow>(
            "SELECT id, tenant_id, ipv4, stable_id, online, hostname, owner, tags, ephemeral, advertised_routes, approved_routes FROM coord_nodes WHERE tenant_id = $1 ORDER BY id"
        )
            .bind(tenant_id.as_uuid())
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default();

        rows.into_iter().filter_map(summary_row_to_summary).collect()
    }

    pub async fn get_node_info(&self, node_id: NodeId) -> Option<NodeDetail> {
        let row = sqlx::query_as::<_, (uuid::Uuid, String, String, Vec<u8>, Vec<u8>, Option<String>, serde_json::Value, String, String, bool)>(
            "SELECT tenant_id, ipv4, stable_id, node_key, machine_key, disco_key, endpoints, hostname, os, online \
             FROM coord_nodes WHERE id = $1"
        )
            .bind(node_id.as_i64())
            .fetch_optional(&self.pool)
            .await
            .ok()??;

        let attrs_row = sqlx::query_as::<_, (Option<String>, Json, bool, Json, Json)>(
            "SELECT owner, tags, ephemeral, advertised_routes, approved_routes FROM coord_nodes WHERE id = $1"
        )
            .bind(node_id.as_i64())
            .fetch_optional(&self.pool)
            .await
            .ok()??;

        let (tenant_uuid, ip_str, stable_id, node_key, machine_key, disco_key, endpoints_json, hostname, os, online) = row;
        let ipv4: Ipv4Addr = ip_str.parse().ok()?;
        let endpoints: Vec<String> = serde_json::from_value(endpoints_json).unwrap_or_default();

        Some(NodeDetail {
            tenant_id: TenantId::new(tenant_uuid),
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
            "SELECT ipv4 FROM coord_nodes WHERE id = $1"
        )
            .bind(node_id.as_i64())
            .fetch_optional(&self.pool)
            .await
            .ok()?;
        ip_str.and_then(|s| s.parse().ok())
    }

    pub async fn get_node_stable_id(&self, node_id: NodeId) -> Option<String> {
        sqlx::query_scalar("SELECT stable_id FROM coord_nodes WHERE id = $1")
            .bind(node_id.as_i64())
            .fetch_optional(&self.pool)
            .await
            .ok()?
    }

    pub async fn get_node_tenant(&self, node_id: NodeId) -> Option<TenantId> {
        let uuid: Option<uuid::Uuid> = sqlx::query_scalar(
            "SELECT tenant_id FROM coord_nodes WHERE id = $1"
        )
            .bind(node_id.as_i64())
            .fetch_optional(&self.pool)
            .await
            .ok()?;
        uuid.map(TenantId::new)
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
        let tenant_uuid: Option<uuid::Uuid> = sqlx::query_scalar(
            "DELETE FROM coord_nodes WHERE id = $1 RETURNING tenant_id"
        )
            .bind(node_id.as_i64())
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?;

        match tenant_uuid {
            Some(uuid) => {
                let tid = TenantId::new(uuid);
                self.emit(PeerEvent::NodeOffline { tenant_id: tid, node_id }).await;
                Ok(tid)
            }
            None => Err(CoordError::Protocol("node not found".into())),
        }
    }

    pub async fn rename_node(&self, node_id: NodeId, new_name: String) -> Result<(), CoordError> {
        let result = sqlx::query_as::<_, (uuid::Uuid,)>(
            "UPDATE coord_nodes SET hostname = $1 WHERE id = $2 RETURNING tenant_id"
        )
            .bind(&new_name)
            .bind(node_id.as_i64())
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?;
        match result {
            Some((uuid,)) => {
                self.emit(PeerEvent::NodeUpdated {
                    tenant_id: TenantId::new(uuid), node_id,
                }).await;
                Ok(())
            }
            None => Err(CoordError::Protocol("node not found".into())),
        }
    }

    pub async fn set_node_online(&self, node_id: NodeId, online: bool) -> Result<(), CoordError> {
        let result: Option<uuid::Uuid> = sqlx::query_scalar(
            "UPDATE coord_nodes SET online = $1, last_seen = NOW() WHERE id = $2 RETURNING tenant_id"
        )
            .bind(online)
            .bind(node_id.as_i64())
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?;

        if let Some(tenant_uuid) = result {
            if online {
                self.emit(PeerEvent::NodeUpdated {
                    tenant_id: TenantId::new(tenant_uuid),
                    node_id,
                }).await;
            } else {
                self.emit(PeerEvent::NodeOffline {
                    tenant_id: TenantId::new(tenant_uuid),
                    node_id,
                }).await;
            }
        }
        Ok(())
    }

    pub async fn set_node_offline_if_current(&self, node_id: NodeId, generation: u64) -> Result<(), CoordError> {
        let result: Option<uuid::Uuid> = sqlx::query_scalar(
            "UPDATE coord_nodes SET online = FALSE, last_seen = NOW() \
             WHERE id = $1 AND session_generation = $2 \
             RETURNING tenant_id"
        )
            .bind(node_id.as_i64())
            .bind(generation as i64)
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?;

        if let Some(tenant_uuid) = result {
            self.emit(PeerEvent::NodeOffline {
                tenant_id: TenantId::new(tenant_uuid),
                node_id,
            }).await;
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
        let sql = format!(
            "UPDATE coord_nodes SET {column} = $1 WHERE id = $2 AND {column} IS DISTINCT FROM $1 RETURNING tenant_id"
        );
        let changed: Option<uuid::Uuid> = sqlx::query_scalar(&sql)
            .bind(to_json(&routes))
            .bind(node_id.as_i64())
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?;
        match changed {
            Some(tenant_uuid) => {
                self.emit(PeerEvent::NodeUpdated { tenant_id: TenantId::new(tenant_uuid), node_id }).await;
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
            "DELETE FROM coord_nodes WHERE tenant_id = $1 AND owner = $2 RETURNING id"
        )
            .bind(tenant_id.as_uuid())
            .bind(owner)
            .fetch_all(&self.pool)
            .await
            .map_err(db)?;
        ids.sort_unstable();
        let ids: Vec<NodeId> = ids.into_iter().map(NodeId::new).collect();
        for node_id in &ids {
            self.emit(PeerEvent::NodeOffline { tenant_id, node_id: *node_id }).await;
        }
        Ok(ids)
    }

    pub async fn delete_stale_ephemeral_nodes(
        &self,
        max_offline: chrono::Duration,
    ) -> Result<Vec<(TenantId, NodeId)>, CoordError> {
        let cutoff = Utc::now() - max_offline;
        let mut rows: Vec<(i64, uuid::Uuid)> = sqlx::query_as(
            "DELETE FROM coord_nodes WHERE ephemeral = TRUE AND online = FALSE AND last_seen <= $1 \
             RETURNING id, tenant_id"
        )
            .bind(cutoff)
            .fetch_all(&self.pool)
            .await
            .map_err(db)?;
        rows.sort_unstable_by_key(|(id, _)| *id);
        let removed: Vec<(TenantId, NodeId)> = rows
            .into_iter()
            .map(|(id, t)| (TenantId::new(t), NodeId::new(id)))
            .collect();
        for (tenant_id, node_id) in &removed {
            self.emit(PeerEvent::NodeOffline { tenant_id: *tenant_id, node_id: *node_id }).await;
        }
        Ok(removed)
    }

    pub async fn get_tenant_route_snapshot(
        &self,
        tenant_id: TenantId,
    ) -> Result<crate::memory::TenantRouteSnapshot, CoordError> {
        let mut tx = self.pool.begin().await.map_err(db)?;

        let tenant_exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM coord_tenants WHERE id = $1)"
        )
            .bind(tenant_id.as_uuid())
            .fetch_one(&mut *tx)
            .await
            .unwrap_or(false);

        if !tenant_exists {
            return Err(CoordError::TenantNotFound(tenant_id));
        }

        let child_rows = sqlx::query_as::<_, TenantRow>(
            "SELECT id, slug, parent_id, federation_posture, ipv4_prefix, ipv6_prefix, created_at, suspended \
             FROM coord_tenants WHERE parent_id = $1 ORDER BY created_at"
        )
            .bind(tenant_id.as_uuid())
            .fetch_all(&mut *tx)
            .await
            .unwrap_or_default();

        let children: Vec<Tenant> = child_rows.into_iter()
            .map(tenant_from_row)
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
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        tenant_id: TenantId,
    ) -> Vec<PeerInfo> {
        let rows = sqlx::query_as::<_, PeerRow>(
            "SELECT id, node_key, machine_key, disco_key, endpoints, ipv4, hostname, online, last_seen, advertised_routes, approved_routes, owner \
             FROM coord_nodes WHERE tenant_id = $1"
        )
            .bind(tenant_id.as_uuid())
            .fetch_all(&mut **tx)
            .await
            .unwrap_or_default();

        rows.into_iter().map(peer_row_to_info).collect()
    }
}

impl std::fmt::Debug for PgStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PgStore").finish()
    }
}

type PeerRow = (i64, Vec<u8>, Vec<u8>, Option<String>, Json, String, String, bool, DateTime<Utc>, Json, Json, Option<String>);
type SummaryRow = (i64, uuid::Uuid, String, String, bool, String, Option<String>, Json, bool, Json, Json);

fn to_json(v: &[String]) -> Json {
    serde_json::to_value(v).unwrap_or_else(|_| Json::Array(vec![]))
}

fn from_json(v: Json) -> Vec<String> {
    serde_json::from_value(v).unwrap_or_default()
}

fn attrs_from_parts((owner, tags, ephemeral, advertised, approved): (Option<String>, Json, bool, Json, Json)) -> NodeAttrs {
    NodeAttrs {
        owner,
        tags: from_json(tags),
        ephemeral,
        advertised_routes: from_json(advertised),
        approved_routes: from_json(approved),
    }
}

fn peer_row_to_info(
    (id, node_key, machine_key, disco_key, endpoints_json, ip_str, hostname, online, last_seen, advertised, approved, owner): PeerRow,
) -> PeerInfo {
    let endpoints: Vec<String> = serde_json::from_value(endpoints_json).unwrap_or_default();
    let (addresses, allowed_ips, primary_routes) =
        coord_core::node_route_sets(&ip_str, &from_json(advertised), &from_json(approved));
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
        last_seen: Some(last_seen),
        owner,
    }
}

fn summary_row_to_summary(
    (id, tenant_uuid, ip_str, stable_id, online, hostname, owner, tags, ephemeral, advertised, approved): SummaryRow,
) -> Option<NodeSummary> {
    let ipv4: Ipv4Addr = ip_str.parse().ok()?;
    Some(NodeSummary {
        id: NodeId::new(id),
        tenant_id: TenantId::new(tenant_uuid),
        ipv4,
        stable_id,
        online,
        hostname,
        attrs: attrs_from_parts((owner, tags, ephemeral, advertised, approved)),
    })
}

type TenantRow = (uuid::Uuid, String, Option<uuid::Uuid>, String, String, String, DateTime<Utc>, bool);

fn tenant_from_row(
    (id, slug, parent_uuid, posture_str, ipv4_prefix, ipv6_prefix, created_at, suspended): TenantRow,
) -> Tenant {
    Tenant {
        id: TenantId::new(id),
        slug,
        parent_id: parent_uuid.map(TenantId::new),
        federation_posture: parse_posture(&posture_str),
        ipv4_prefix,
        ipv6_prefix,
        created_at,
        suspended,
    }
}

fn parse_posture(s: &str) -> FederationPosture {
    s.parse().unwrap_or_else(|_| {
        tracing::warn!(value = s, "unknown federation posture, defaulting to Closed");
        FederationPosture::Closed
    })
}

#[cfg(test)]
mod event_tests {
    use super::*;

    fn tenant() -> TenantId {
        TenantId::new("11111111-2222-4333-8444-555555555555".parse().unwrap())
    }

    #[test]
    fn peer_and_remote_events_round_trip_between_replicas() {
        for e in [
            PeerEvent::NodeJoined { tenant_id: tenant(), node_id: NodeId::new(7) },
            PeerEvent::NodeUpdated { tenant_id: tenant(), node_id: NodeId::new(8) },
            PeerEvent::NodeOffline { tenant_id: tenant(), node_id: NodeId::new(9) },
        ] {
            assert_eq!(decode_event(&encode_peer("a", e), "b"), Some(Decoded::Peer(e)));
        }
        for e in [RemoteEvent::TenantChanged(tenant()), RemoteEvent::SignInDecided("ab12".into())] {
            assert_eq!(decode_event(&encode_remote("a", &e), "b"), Some(Decoded::Remote(e)));
        }
    }

    #[test]
    fn own_and_malformed_notifications_are_ignored() {
        let own = encode_peer("a", PeerEvent::NodeJoined { tenant_id: tenant(), node_id: NodeId::new(1) });
        assert_eq!(decode_event(&own, "a"), None);
        for bad in ["", "b|j", "b|j|not-a-uuid|1", "b|j|11111111-2222-4333-8444-555555555555|x", "b|z|11111111-2222-4333-8444-555555555555|1"] {
            assert_eq!(decode_event(bad, "a"), None, "{bad}");
        }
    }

    #[test]
    fn nil_tenant_ids_and_non_positive_node_ids_are_ignored() {
        let nil = "00000000-0000-0000-0000-000000000000";
        for bad in [
            format!("b|t|{nil}|"),
            format!("b|j|{nil}|1"),
            format!("b|o|{nil}|1"),
            "b|u|11111111-2222-4333-8444-555555555555|0".to_string(),
            "b|u|11111111-2222-4333-8444-555555555555|-4".to_string(),
        ] {
            assert_eq!(decode_event(&bad, "a"), None, "{bad}");
        }
    }

    #[test]
    fn resync_is_never_published() {
        assert_eq!(encode_remote("a", &RemoteEvent::Resync), "");
        assert_eq!(decode_event("", "b"), None);
    }
}
