use std::net::Ipv4Addr;
use sqlx::PgPool;
use tokio::sync::broadcast;

use coord_core::{NodeId, NodeInfo, PeerInfo, TenantId};
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

    pub async fn create_preauth_key(&self, tenant_id: TenantId, reusable: bool) -> String {
        let key = format!("tskey-auth-{}", generate_random_id());
        sqlx::query(
            "INSERT INTO coord_preauth_keys (key, tenant_id, reusable) VALUES ($1, $2, $3)"
        )
            .bind(&key)
            .bind(tenant_id.as_uuid())
            .bind(reusable)
            .execute(&self.pool)
            .await
            .expect("insert preauth key");
        key
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
    ) -> (NodeId, Ipv4Addr) {
        let endpoints_json = serde_json::to_value(&info.endpoints).unwrap();

        // Allocate IP in Rust from a single nextval, then do atomic upsert.
        let ip_offset: i64 = sqlx::query_scalar("SELECT nextval('coord_ipv4_seq')")
            .fetch_one(&self.pool)
            .await
            .expect("allocate IP");

        let base_ip = u32::from(Ipv4Addr::new(100, 64, 0, 0));
        let new_ipv4 = Ipv4Addr::from(base_ip + ip_offset as u32);
        let max_cgnat = u32::from(Ipv4Addr::new(100, 127, 255, 255));
        assert!(u32::from(new_ipv4) <= max_cgnat, "CGNAT address space exhausted");
        let new_ip_str = new_ipv4.to_string();

        // ON CONFLICT keeps the existing ipv4/stable_id but updates mutable fields.
        // The pre-allocated IP is wasted on conflict (acceptable — sequence gaps are fine).
        let row = sqlx::query_as::<_, (i64, String, bool)>(
            "INSERT INTO coord_nodes (tenant_id, machine_key, node_key, disco_key, stable_id, ipv4, hostname, os, endpoints) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) \
             ON CONFLICT (machine_key) DO UPDATE SET \
                 node_key = EXCLUDED.node_key, \
                 disco_key = EXCLUDED.disco_key, \
                 hostname = EXCLUDED.hostname, \
                 os = EXCLUDED.os, \
                 endpoints = EXCLUDED.endpoints, \
                 online = TRUE, \
                 last_seen = NOW() \
             RETURNING id, ipv4, (xmax = 0) AS is_insert"
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
            .await
            .expect("upsert node");

        let (id, ip_str, is_insert) = row;
        let ipv4: Ipv4Addr = ip_str.parse().expect("valid stored IPv4");

        let node_id = NodeId::new(id);
        if is_insert {
            let _ = self.peer_tx.send(PeerEvent::NodeJoined {
                tenant_id,
                node_id,
            });
        } else {
            let _ = self.peer_tx.send(PeerEvent::NodeUpdated {
                tenant_id,
                node_id,
            });
        }

        (node_id, ipv4)
    }

    pub async fn rotate_node_key(
        &self,
        machine_key: &[u8; 32],
        _old_node_key: &[u8; 32],
        new_node_key: &[u8; 32],
    ) {
        let result = sqlx::query_as::<_, (i64, uuid::Uuid)>(
            "UPDATE coord_nodes SET node_key = $1 WHERE machine_key = $2 RETURNING id, tenant_id"
        )
            .bind(&new_node_key[..])
            .bind(&machine_key[..])
            .fetch_optional(&self.pool)
            .await
            .expect("rotate node key");

        if let Some((id, tenant_uuid)) = result {
            let _ = self.peer_tx.send(PeerEvent::NodeUpdated {
                tenant_id: TenantId::new(tenant_uuid),
                node_id: NodeId::new(id),
            });
        }
    }

    pub async fn update_endpoints(
        &self,
        node_id: NodeId,
        endpoints: Vec<String>,
        disco_key: Option<String>,
    ) {
        let mut updated = false;

        if !endpoints.is_empty() {
            sqlx::query("UPDATE coord_nodes SET endpoints = $1 WHERE id = $2")
                .bind(serde_json::to_value(&endpoints).unwrap())
                .bind(node_id.as_i64())
                .execute(&self.pool)
                .await
                .expect("update endpoints");
            updated = true;
        }

        if let Some(dk) = disco_key {
            sqlx::query("UPDATE coord_nodes SET disco_key = $1 WHERE id = $2")
                .bind(&dk)
                .bind(node_id.as_i64())
                .execute(&self.pool)
                .await
                .expect("update disco key");
            updated = true;
        }

        if updated {
            let tenant_uuid: Option<uuid::Uuid> = sqlx::query_scalar(
                "SELECT tenant_id FROM coord_nodes WHERE id = $1"
            )
                .bind(node_id.as_i64())
                .fetch_optional(&self.pool)
                .await
                .expect("get tenant");

            if let Some(tenant_uuid) = tenant_uuid {
                let _ = self.peer_tx.send(PeerEvent::NodeUpdated {
                    tenant_id: TenantId::new(tenant_uuid),
                    node_id,
                });
            }
        }
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

    pub async fn set_node_online(&self, node_id: NodeId, online: bool) {
        let result: Option<uuid::Uuid> = sqlx::query_scalar(
            "UPDATE coord_nodes SET online = $1, last_seen = NOW() WHERE id = $2 RETURNING tenant_id"
        )
            .bind(online)
            .bind(node_id.as_i64())
            .fetch_optional(&self.pool)
            .await
            .expect("update online status");

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
