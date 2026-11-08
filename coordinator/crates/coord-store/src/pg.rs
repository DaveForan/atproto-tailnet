use std::net::Ipv4Addr;
use sqlx::PgPool;
use tokio::sync::broadcast;

use coord_core::{CoordError, FederationPosture, NodeId, NodeInfo, PeerInfo, Tenant, TenantId};
use crate::memory::PeerEvent;

pub struct PgStore {
    pool: PgPool,
    peer_tx: broadcast::Sender<PeerEvent>,
}

impl PgStore {
    pub async fn new(pool: PgPool) -> Result<Self, sqlx::Error> {
        sqlx::migrate!("../../migrations")
            .run(&pool)
            .await?;

        let (peer_tx, _) = broadcast::channel(256);
        Ok(Self { pool, peer_tx })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<PeerEvent> {
        self.peer_tx.subscribe()
    }

    pub async fn create_tenant(
        &self,
        slug: String,
        parent_id: Option<TenantId>,
    ) -> Result<Tenant, CoordError> {
        let id = TenantId::generate();
        let parent_uuid = parent_id.map(|p| *p.as_uuid());

        if let Some(pid) = parent_uuid {
            let parent_row: Option<(uuid::Uuid, Option<uuid::Uuid>)> = sqlx::query_as(
                "SELECT id, parent_id FROM coord_tenants WHERE id = $1"
            )
                .bind(pid)
                .fetch_optional(&self.pool)
                .await?;

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
            "INSERT INTO coord_tenants (id, slug, parent_id) VALUES ($1, $2, $3)"
        )
            .bind(id.as_uuid())
            .bind(&slug)
            .bind(parent_uuid)
            .execute(&self.pool)
            .await?;

        Ok(Tenant {
            id,
            slug,
            parent_id,
            federation_posture: FederationPosture::default(),
            ipv4_prefix: "100.64.0.0/10".into(),
            ipv6_prefix: "fd7a:115c:a1e0::/48".into(),
            created_at: chrono::Utc::now(),
        })
    }

    pub async fn get_tenant(&self, tenant_id: TenantId) -> Option<Tenant> {
        let row = sqlx::query_as::<_, (uuid::Uuid, String, Option<uuid::Uuid>, String, String, String, chrono::DateTime<chrono::Utc>)>(
            "SELECT id, slug, parent_id, federation_posture, ipv4_prefix, ipv6_prefix, created_at \
             FROM coord_tenants WHERE id = $1"
        )
            .bind(tenant_id.as_uuid())
            .fetch_optional(&self.pool)
            .await
            .ok()??;

        let (id, slug, parent_uuid, posture_str, ipv4_prefix, ipv6_prefix, created_at) = row;
        Some(Tenant {
            id: TenantId::new(id),
            slug,
            parent_id: parent_uuid.map(TenantId::new),
            federation_posture: parse_posture(&posture_str),
            ipv4_prefix,
            ipv6_prefix,
            created_at,
        })
    }

    pub async fn list_tenants(&self) -> Vec<Tenant> {
        let rows = sqlx::query_as::<_, (uuid::Uuid, String, Option<uuid::Uuid>, String, String, String, chrono::DateTime<chrono::Utc>)>(
            "SELECT id, slug, parent_id, federation_posture, ipv4_prefix, ipv6_prefix, created_at \
             FROM coord_tenants ORDER BY created_at"
        )
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default();

        rows.into_iter()
            .map(|(id, slug, parent_uuid, posture_str, ipv4_prefix, ipv6_prefix, created_at)| {
                Tenant {
                    id: TenantId::new(id),
                    slug,
                    parent_id: parent_uuid.map(TenantId::new),
                    federation_posture: parse_posture(&posture_str),
                    ipv4_prefix,
                    ipv6_prefix,
                    created_at,
                }
            })
            .collect()
    }

    pub async fn delete_tenant(&self, tenant_id: TenantId) -> Result<(), CoordError> {
        let mut tx = self.pool.begin().await?;

        // Check for children first
        let child_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM coord_tenants WHERE parent_id = $1"
        )
            .bind(tenant_id.as_uuid())
            .fetch_one(&mut *tx)
            .await?;

        if child_count > 0 {
            return Err(CoordError::Protocol(
                "cannot delete tenant with children".into(),
            ));
        }

        // Collect node IDs for offline events
        let node_ids: Vec<i64> = sqlx::query_scalar(
            "SELECT id FROM coord_nodes WHERE tenant_id = $1"
        )
            .bind(tenant_id.as_uuid())
            .fetch_all(&mut *tx)
            .await?;

        // Delete nodes
        sqlx::query("DELETE FROM coord_nodes WHERE tenant_id = $1")
            .bind(tenant_id.as_uuid())
            .execute(&mut *tx)
            .await?;

        // Delete preauth keys
        sqlx::query("DELETE FROM coord_preauth_keys WHERE tenant_id = $1")
            .bind(tenant_id.as_uuid())
            .execute(&mut *tx)
            .await?;

        // Delete the tenant
        let result = sqlx::query("DELETE FROM coord_tenants WHERE id = $1")
            .bind(tenant_id.as_uuid())
            .execute(&mut *tx)
            .await?;

        if result.rows_affected() == 0 {
            return Err(CoordError::TenantNotFound(tenant_id));
        }

        tx.commit().await?;

        // Broadcast NodeOffline for each removed node (after commit)
        for nid in node_ids {
            let _ = self.peer_tx.send(PeerEvent::NodeOffline {
                tenant_id,
                node_id: NodeId::new(nid),
            });
        }

        Ok(())
    }

    pub async fn get_child_tenants(&self, parent_id: TenantId) -> Vec<Tenant> {
        let rows = sqlx::query_as::<_, (uuid::Uuid, String, Option<uuid::Uuid>, String, String, String, chrono::DateTime<chrono::Utc>)>(
            "SELECT id, slug, parent_id, federation_posture, ipv4_prefix, ipv6_prefix, created_at \
             FROM coord_tenants WHERE parent_id = $1 ORDER BY created_at"
        )
            .bind(parent_id.as_uuid())
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default();

        rows.into_iter()
            .map(|(id, slug, parent_uuid, posture_str, ipv4_prefix, ipv6_prefix, created_at)| {
                Tenant {
                    id: TenantId::new(id),
                    slug,
                    parent_id: parent_uuid.map(TenantId::new),
                    federation_posture: parse_posture(&posture_str),
                    ipv4_prefix,
                    ipv6_prefix,
                    created_at,
                }
            })
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
        let row = sqlx::query_as::<_, (uuid::Uuid, String, Option<uuid::Uuid>, String, String, String, chrono::DateTime<chrono::Utc>)>(
            "UPDATE coord_tenants SET federation_posture = $1 WHERE id = $2 \
             RETURNING id, slug, parent_id, federation_posture, ipv4_prefix, ipv6_prefix, created_at"
        )
            .bind(posture_str)
            .bind(tenant_id.as_uuid())
            .fetch_optional(&self.pool)
            .await?;

        match row {
            Some((id, slug, parent_uuid, ps, ipv4_prefix, ipv6_prefix, created_at)) => Ok(Tenant {
                id: TenantId::new(id),
                slug,
                parent_id: parent_uuid.map(TenantId::new),
                federation_posture: parse_posture(&ps),
                ipv4_prefix,
                ipv6_prefix,
                created_at,
            }),
            None => Err(CoordError::TenantNotFound(tenant_id)),
        }
    }

    pub async fn create_preauth_key(&self, tenant_id: TenantId, reusable: bool) -> Result<String, CoordError> {
        let key = format!("tskey-auth-{}", generate_random_id());
        sqlx::query(
            "INSERT INTO coord_preauth_keys (key, tenant_id, reusable) VALUES ($1, $2, $3)"
        )
            .bind(&key)
            .bind(tenant_id.as_uuid())
            .bind(reusable)
            .execute(&self.pool)
            .await?;
        Ok(key)
    }

    pub async fn validate_preauth_key(&self, key: &str) -> Option<TenantId> {
        // Atomic: UPDATE with all conditions in WHERE, RETURNING tenant_id.
        // Only succeeds if the key exists, is not expired, and is either
        // unused or reusable. Prevents double-use race on single-use keys.
        let tenant_uuid: Option<uuid::Uuid> = sqlx::query_scalar(
            "UPDATE coord_preauth_keys SET used = TRUE \
             WHERE key = $1 \
               AND (used = FALSE OR reusable = TRUE) \
               AND (expires_at IS NULL OR expires_at > NOW()) \
             RETURNING tenant_id"
        )
            .bind(key)
            .fetch_optional(&self.pool)
            .await
            .ok()?;

        tenant_uuid.map(TenantId::new)
    }

    pub async fn register_node(
        &self,
        tenant_id: TenantId,
        machine_key: [u8; 32],
        info: NodeInfo,
    ) -> Result<(NodeId, Ipv4Addr, u64), CoordError> {
        let endpoints_json = serde_json::to_value(&info.endpoints).unwrap();

        // Check if a node with this machine_key already exists
        let existing = sqlx::query_as::<_, (i64, uuid::Uuid, String, i64)>(
            "SELECT id, tenant_id, ipv4, session_generation FROM coord_nodes WHERE machine_key = $1"
        )
            .bind(&machine_key[..])
            .fetch_optional(&self.pool)
            .await?;

        if let Some((id, existing_tenant_uuid, ip_str, old_generation)) = existing {
            let existing_tenant = TenantId::new(existing_tenant_uuid);
            if existing_tenant != tenant_id {
                return Err(CoordError::Protocol(
                    "machine key already registered to a different tenant".into(),
                ));
            }
            // Update existing node
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
                .await?;

            let ipv4: Ipv4Addr = ip_str.parse().map_err(|_| CoordError::Protocol("invalid stored IPv4".into()))?;
            let node_id = NodeId::new(id);
            let _ = self.peer_tx.send(PeerEvent::NodeUpdated {
                tenant_id,
                node_id,
            });
            return Ok((node_id, ipv4, new_gen as u64));
        }

        // New node: allocate IP and insert
        let ip_offset: i64 = sqlx::query_scalar("SELECT nextval('coord_ipv4_seq')")
            .fetch_one(&self.pool)
            .await?;

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
            "INSERT INTO coord_nodes (tenant_id, machine_key, node_key, disco_key, stable_id, ipv4, hostname, os, endpoints, session_generation) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1) \
             RETURNING id, session_generation"
        )
            .bind(tenant_id.as_uuid())
            .bind(&machine_key[..])
            .bind(&info.node_key)
            .bind(&info.disco_key)
            .bind(&generate_random_id())
            .bind(&new_ip_str)
            .bind(&info.hostname)
            .bind(&info.os)
            .bind(&endpoints_json)
            .fetch_one(&self.pool)
            .await?;

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
            .await?;

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
                .await?;
            updated = true;
        }

        if let Some(dk) = disco_key {
            sqlx::query("UPDATE coord_nodes SET disco_key = $1 WHERE id = $2")
                .bind(&dk)
                .bind(node_id.as_i64())
                .execute(&self.pool)
                .await?;
            updated = true;
        }

        if updated {
            let tenant_uuid: Option<uuid::Uuid> = sqlx::query_scalar(
                "SELECT tenant_id FROM coord_nodes WHERE id = $1"
            )
                .bind(node_id.as_i64())
                .fetch_optional(&self.pool)
                .await?;

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
        let rows = sqlx::query_as::<_, (i64, Vec<u8>, Option<String>, serde_json::Value, String, String, bool, chrono::DateTime<chrono::Utc>)>(
            "SELECT id, node_key, disco_key, endpoints, ipv4, hostname, online, last_seen \
             FROM coord_nodes WHERE tenant_id = $1 AND id != $2"
        )
            .bind(tenant_id.as_uuid())
            .bind(exclude_node.as_i64())
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default();

        rows.into_iter()
            .map(|(id, node_key, disco_key, endpoints_json, ip_str, hostname, online, last_seen)| {
                let endpoints: Vec<String> = serde_json::from_value(endpoints_json).unwrap_or_default();
                PeerInfo {
                    node_id: NodeId::new(id),
                    node_key,
                    disco_key,
                    endpoints,
                    allowed_ips: vec![format!("{}/32", ip_str)],
                    hostname,
                    derp_region: Some(1),
                    online,
                    last_seen: Some(last_seen),
                }
            })
            .collect()
    }

    pub async fn get_peers_with_children(
        &self,
        tenant_id: TenantId,
        exclude_node: NodeId,
    ) -> Vec<PeerInfo> {
        let rows = sqlx::query_as::<_, (i64, Vec<u8>, Option<String>, serde_json::Value, String, String, bool, chrono::DateTime<chrono::Utc>)>(
            "SELECT n.id, n.node_key, n.disco_key, n.endpoints, n.ipv4, n.hostname, n.online, n.last_seen \
             FROM coord_nodes n \
             WHERE n.id != $2 AND ( \
                 n.tenant_id = $1 \
                 OR n.tenant_id IN ( \
                     SELECT id FROM coord_tenants \
                     WHERE parent_id = $1 AND federation_posture != 'closed' \
                 ) \
             )"
        )
            .bind(tenant_id.as_uuid())
            .bind(exclude_node.as_i64())
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default();

        rows.into_iter()
            .map(|(id, node_key, disco_key, endpoints_json, ip_str, hostname, online, last_seen)| {
                let endpoints: Vec<String> = serde_json::from_value(endpoints_json).unwrap_or_default();
                PeerInfo {
                    node_id: NodeId::new(id),
                    node_key,
                    disco_key,
                    endpoints,
                    allowed_ips: vec![format!("{}/32", ip_str)],
                    hostname,
                    derp_region: Some(1),
                    online,
                    last_seen: Some(last_seen),
                }
            })
            .collect()
    }

    pub async fn list_tenant_nodes(&self, tenant_id: TenantId) -> Vec<PeerInfo> {
        let rows = sqlx::query_as::<_, (i64, Vec<u8>, Option<String>, serde_json::Value, String, String, bool, chrono::DateTime<chrono::Utc>)>(
            "SELECT id, node_key, disco_key, endpoints, ipv4, hostname, online, last_seen \
             FROM coord_nodes WHERE tenant_id = $1"
        )
            .bind(tenant_id.as_uuid())
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default();

        rows.into_iter()
            .map(|(id, node_key, disco_key, endpoints_json, ip_str, hostname, online, last_seen)| {
                let endpoints: Vec<String> = serde_json::from_value(endpoints_json).unwrap_or_default();
                PeerInfo {
                    node_id: NodeId::new(id),
                    node_key,
                    disco_key,
                    endpoints,
                    allowed_ips: vec![format!("{}/32", ip_str)],
                    hostname,
                    derp_region: Some(1),
                    online,
                    last_seen: Some(last_seen),
                }
            })
            .collect()
    }

    pub async fn list_nodes_for_tenant(&self, tenant_id: TenantId) -> Vec<(NodeId, TenantId, Ipv4Addr, String, bool, String)> {
        let rows = sqlx::query_as::<_, (i64, uuid::Uuid, String, String, bool, String)>(
            "SELECT id, tenant_id, ipv4, stable_id, online, hostname FROM coord_nodes WHERE tenant_id = $1 ORDER BY id"
        )
            .bind(tenant_id.as_uuid())
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default();

        rows.into_iter()
            .filter_map(|(id, tenant_uuid, ip_str, stable_id, online, hostname)| {
                let ipv4: Ipv4Addr = ip_str.parse().ok()?;
                Some((NodeId::new(id), TenantId::new(tenant_uuid), ipv4, stable_id, online, hostname))
            })
            .collect()
    }

    pub async fn get_node_info(&self, node_id: NodeId) -> Option<(TenantId, Ipv4Addr, String, NodeInfo)> {
        let row = sqlx::query_as::<_, (uuid::Uuid, String, String, Vec<u8>, Vec<u8>, Option<String>, serde_json::Value, String, String)>(
            "SELECT tenant_id, ipv4, stable_id, node_key, machine_key, disco_key, endpoints, hostname, os \
             FROM coord_nodes WHERE id = $1"
        )
            .bind(node_id.as_i64())
            .fetch_optional(&self.pool)
            .await
            .ok()??;

        let (tenant_uuid, ip_str, stable_id, node_key, machine_key, disco_key, endpoints_json, hostname, os) = row;
        let ipv4: Ipv4Addr = ip_str.parse().ok()?;
        let endpoints: Vec<String> = serde_json::from_value(endpoints_json).unwrap_or_default();

        Some((
            TenantId::new(tenant_uuid),
            ipv4,
            stable_id,
            NodeInfo {
                node_key,
                machine_key,
                disco_key,
                endpoints,
                hostname,
                os,
                ipv4: None,
                ipv6: None,
            },
        ))
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

    pub async fn list_nodes(&self) -> Vec<(NodeId, TenantId, Ipv4Addr, String, bool, String)> {
        let rows = sqlx::query_as::<_, (i64, uuid::Uuid, String, String, bool, String)>(
            "SELECT id, tenant_id, ipv4, stable_id, online, hostname FROM coord_nodes ORDER BY id"
        )
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default();

        rows.into_iter()
            .filter_map(|(id, tenant_uuid, ip_str, stable_id, online, hostname)| {
                let ipv4: Ipv4Addr = ip_str.parse().ok()?;
                Some((NodeId::new(id), TenantId::new(tenant_uuid), ipv4, stable_id, online, hostname))
            })
            .collect()
    }

    pub async fn delete_node(&self, node_id: NodeId) -> Result<TenantId, CoordError> {
        let tenant_uuid: Option<uuid::Uuid> = sqlx::query_scalar(
            "DELETE FROM coord_nodes WHERE id = $1 RETURNING tenant_id"
        )
            .bind(node_id.as_i64())
            .fetch_optional(&self.pool)
            .await?;

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
            .await?;
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
            .await?;

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
            .await?;

        if let Some(tenant_uuid) = result {
            let _ = self.peer_tx.send(PeerEvent::NodeOffline {
                tenant_id: TenantId::new(tenant_uuid),
                node_id,
            });
        }
        Ok(())
    }
    pub async fn get_tenant_route_snapshot(
        &self,
        tenant_id: TenantId,
    ) -> Result<crate::memory::TenantRouteSnapshot, CoordError> {
        // PgStore: each SQL statement sees a consistent snapshot, and we group
        // reads here so callers get a coherent view.
        if self.get_tenant(tenant_id).await.is_none() {
            return Err(CoordError::TenantNotFound(tenant_id));
        }
        let children = self.get_child_tenants(tenant_id).await;
        let own_nodes = self.list_tenant_nodes(tenant_id).await;
        let mut visible_child_nodes = Vec::new();
        for child in &children {
            if child.federation_posture != coord_core::FederationPosture::Closed {
                let child_nodes = self.list_tenant_nodes(child.id).await;
                visible_child_nodes.push((child.id, child.slug.clone(), child_nodes));
            }
        }
        Ok(crate::memory::TenantRouteSnapshot {
            children,
            own_nodes,
            visible_child_nodes,
        })
    }
}

impl std::fmt::Debug for PgStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PgStore").finish()
    }
}

fn generate_random_id() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 8];
    rand::rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

fn parse_posture(s: &str) -> FederationPosture {
    match s {
        "open" => FederationPosture::Open,
        "selective" => FederationPosture::Selective,
        _ => FederationPosture::Closed,
    }
}
