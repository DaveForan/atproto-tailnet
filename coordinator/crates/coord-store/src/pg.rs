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
use crate::{generate_auth_key, generate_random_id};

fn db(e: sqlx::Error) -> StorageError {
    StorageError::new(e)
}

pub struct PgStore {
    pool: PgPool,
    peer_tx: broadcast::Sender<PeerEvent>,
}

impl PgStore {
    pub async fn new(pool: PgPool) -> Result<Self, StorageError> {
        sqlx::migrate!("../../migrations")
            .run(&pool)
            .await
            .map_err(StorageError::new)?;

        let (peer_tx, _) = broadcast::channel(crate::PEER_EVENT_CHANNEL_CAPACITY);
        Ok(Self { pool, peer_tx })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<PeerEvent> {
        self.peer_tx.subscribe()
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
            "INSERT INTO coord_preauth_keys (key, id, tenant_id, reusable, ephemeral, expires_at, owner, tags) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)"
        )
            .bind(&key)
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
            "SELECT id, key, owner, tags, reusable, ephemeral, used, expires_at, created_at, revoked_at \
             FROM coord_preauth_keys WHERE tenant_id = $1 ORDER BY created_at, id"
        )
            .bind(tenant_id.as_uuid())
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default();

        rows.into_iter()
            .map(|(id, key, owner, tags, reusable, ephemeral, used, expires_at, created_at, revoked_at)| PreAuthKeyInfo {
                id,
                tenant_id,
                prefix: coord_core::preauth_key_prefix(&key),
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
            .bind(key)
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
            .bind(key)
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

        let existing = sqlx::query_as::<_, (i64, uuid::Uuid, String, i64)>(
            "SELECT id, tenant_id, ipv4, session_generation FROM coord_nodes WHERE machine_key = $1"
        )
            .bind(&machine_key[..])
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?;

        if let Some((id, existing_tenant_uuid, ip_str, old_generation)) = existing {
            let existing_tenant = TenantId::new(existing_tenant_uuid);
            if existing_tenant != tenant_id {
                return Err(CoordError::Protocol(
                    "machine key already registered to a different tenant".into(),
                ));
            }
            let new_gen = old_generation + 1;
            sqlx::query(
                "UPDATE coord_nodes SET node_key = $1, disco_key = $2, hostname = $3, os = $4, \
                 endpoints = $5, online = TRUE, last_seen = NOW(), session_generation = $6 WHERE id = $7"
            )
                .bind(&info.node_key)
                .bind(&info.disco_key)
                .bind(&info.hostname)
                .bind(&info.os)
                .bind(&endpoints_json)
                .bind(new_gen)
                .bind(id)
                .execute(&self.pool)
                .await
                .map_err(db)?;

            if let Some(routes) = reg.advertised_routes {
                sqlx::query("UPDATE coord_nodes SET advertised_routes = $1 WHERE id = $2")
                    .bind(to_json(&routes))
                    .bind(id)
                    .execute(&self.pool)
                    .await
                    .map_err(db)?;
            }

            let ipv4: Ipv4Addr = ip_str.parse().map_err(|_| CoordError::Protocol("invalid stored IPv4".into()))?;
            let node_id = NodeId::new(id);
            let _ = self.peer_tx.send(PeerEvent::NodeUpdated {
                tenant_id,
                node_id,
            });
            return Ok((node_id, ipv4, new_gen as u64));
        }

        let ip_offset: i64 = sqlx::query_scalar("SELECT nextval('coord_ipv4_seq')")
            .fetch_one(&self.pool)
            .await
            .map_err(db)?;

        let base_ip = u32::from(Ipv4Addr::new(100, 64, 0, 0));
        let ip_offset_u32 = u32::try_from(ip_offset).map_err(|_| {
            CoordError::Protocol(format!("IP offset {} exceeds u32 range", ip_offset))
        })?;
        let new_ipv4 = Ipv4Addr::from(base_ip.checked_add(ip_offset_u32).ok_or_else(|| {
            CoordError::AddressSpaceExhausted
        })?);
        let max_cgnat = u32::from(Ipv4Addr::new(100, 127, 255, 255));
        if u32::from(new_ipv4) > max_cgnat {
            return Err(CoordError::AddressSpaceExhausted);
        }
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
            .fetch_one(&self.pool)
            .await
            .map_err(db)?;

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
        let result = sqlx::query_as::<_, (i64, uuid::Uuid)>(
            "UPDATE coord_nodes SET node_key = $1 WHERE machine_key = $2 RETURNING id, tenant_id"
        )
            .bind(&new_node_key[..])
            .bind(&machine_key[..])
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?;

        if let Some((id, tenant_uuid)) = result {
            let _ = self.peer_tx.send(PeerEvent::NodeUpdated {
                tenant_id: TenantId::new(tenant_uuid),
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
                let _ = self.peer_tx.send(PeerEvent::NodeUpdated {
                    tenant_id: TenantId::new(tenant_uuid),
                    node_id,
                });
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

    pub async fn get_peers(&self, tenant_id: TenantId, exclude_node: NodeId) -> Vec<PeerInfo> {
        let rows = sqlx::query_as::<_, PeerRow>(
            "SELECT id, node_key, machine_key, disco_key, endpoints, ipv4, hostname, online, last_seen, advertised_routes, approved_routes \
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
            "SELECT n.id, n.node_key, n.machine_key, n.disco_key, n.endpoints, n.ipv4, n.hostname, n.online, n.last_seen, n.advertised_routes, n.approved_routes \
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
            "SELECT id, node_key, machine_key, disco_key, endpoints, ipv4, hostname, online, last_seen, advertised_routes, approved_routes \
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
                let _ = self.peer_tx.send(PeerEvent::NodeOffline { tenant_id: tid, node_id });
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
                let _ = self.peer_tx.send(PeerEvent::NodeUpdated {
                    tenant_id: TenantId::new(uuid), node_id,
                });
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
                let _ = self.peer_tx.send(PeerEvent::NodeUpdated {
                    tenant_id: TenantId::new(tenant_uuid),
                    node_id,
                });
            } else {
                let _ = self.peer_tx.send(PeerEvent::NodeOffline {
                    tenant_id: TenantId::new(tenant_uuid),
                    node_id,
                });
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
            let _ = self.peer_tx.send(PeerEvent::NodeOffline {
                tenant_id: TenantId::new(tenant_uuid),
                node_id,
            });
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
                let _ = self.peer_tx.send(PeerEvent::NodeUpdated { tenant_id: TenantId::new(tenant_uuid), node_id });
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
            let _ = self.peer_tx.send(PeerEvent::NodeOffline { tenant_id, node_id: *node_id });
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
            let _ = self.peer_tx.send(PeerEvent::NodeOffline { tenant_id: *tenant_id, node_id: *node_id });
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
            "SELECT id, node_key, machine_key, disco_key, endpoints, ipv4, hostname, online, last_seen, advertised_routes, approved_routes \
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

type PeerRow = (i64, Vec<u8>, Vec<u8>, Option<String>, Json, String, String, bool, DateTime<Utc>, Json, Json);
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
    (id, node_key, machine_key, disco_key, endpoints_json, ip_str, hostname, online, last_seen, advertised, approved): PeerRow,
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
