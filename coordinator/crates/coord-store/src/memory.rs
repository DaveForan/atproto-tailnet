use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::Mutex;
use tokio::sync::broadcast;

use coord_core::{CoordError, FederationPosture, NodeId, NodeInfo, PeerInfo, Tenant, TenantId};

use crate::generate_random_id;

#[derive(Debug, Clone, Copy)]
pub enum PeerEvent {
    NodeJoined { tenant_id: TenantId, node_id: NodeId },
    NodeUpdated { tenant_id: TenantId, node_id: NodeId },
    NodeOffline { tenant_id: TenantId, node_id: NodeId },
}

#[derive(Debug)]
struct StoredNode {
    id: NodeId,
    tenant_id: TenantId,
    info: NodeInfo,
    ipv4: Ipv4Addr,
    stable_id: String,
    online: bool,
    session_generation: u64,
    registered_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug)]
struct PreAuthKey {
    #[allow(dead_code)]
    key: String,
    tenant_id: TenantId,
    used: bool,
    reusable: bool,
    expires_at: Option<chrono::DateTime<chrono::Utc>>,
}

pub struct MemoryStore {
    tenants: Mutex<HashMap<TenantId, Tenant>>,
    nodes: Mutex<HashMap<NodeId, StoredNode>>,
    machine_key_index: Mutex<HashMap<[u8; 32], NodeId>>,
    preauth_keys: Mutex<HashMap<String, PreAuthKey>>,
    next_node_id: Mutex<i64>,
    next_ipv4: Mutex<u32>,
    peer_tx: broadcast::Sender<PeerEvent>,
}

impl MemoryStore {
    pub fn new() -> Self {
        let (peer_tx, _) = broadcast::channel(crate::PEER_EVENT_CHANNEL_CAPACITY);
        Self {
            tenants: Mutex::new(HashMap::new()),
            nodes: Mutex::new(HashMap::new()),
            machine_key_index: Mutex::new(HashMap::new()),
            preauth_keys: Mutex::new(HashMap::new()),
            next_node_id: Mutex::new(1),
            next_ipv4: Mutex::new(u32::from(Ipv4Addr::new(100, 64, 0, 1))),
            peer_tx,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<PeerEvent> {
        self.peer_tx.subscribe()
    }

    pub fn create_tenant(
        &self,
        slug: String,
        parent_id: Option<TenantId>,
    ) -> Result<Tenant, CoordError> {
        let mut tenants = self.tenants.lock().unwrap_or_else(|e| e.into_inner());
        if tenants.values().any(|t| t.slug == slug) {
            return Err(CoordError::Protocol(format!("tenant slug '{}' already exists", slug)));
        }
        if let Some(pid) = parent_id {
            match tenants.get(&pid) {
                None => return Err(CoordError::TenantNotFound(pid)),
                Some(parent) => {
                    if parent.parent_id.is_some() {
                        return Err(CoordError::Protocol(
                            "multi-level hierarchy not supported: parent is itself a child".into(),
                        ));
                    }
                }
            }
        }
        let tenant = Tenant {
            id: TenantId::generate(),
            slug,
            parent_id,
            federation_posture: FederationPosture::default(),
            ipv4_prefix: coord_core::DEFAULT_IPV4_PREFIX.into(),
            ipv6_prefix: coord_core::DEFAULT_IPV6_PREFIX.into(),
            created_at: chrono::Utc::now(),
        };
        tenants.insert(tenant.id, tenant.clone());
        Ok(tenant)
    }

    pub fn get_tenant(&self, tenant_id: TenantId) -> Option<Tenant> {
        let tenants = self.tenants.lock().unwrap_or_else(|e| e.into_inner());
        tenants.get(&tenant_id).cloned()
    }

    pub fn list_tenants(&self) -> Vec<Tenant> {
        let tenants = self.tenants.lock().unwrap_or_else(|e| e.into_inner());
        tenants.values().cloned().collect()
    }

    pub fn delete_tenant(&self, tenant_id: TenantId) -> Result<(), CoordError> {
        // Hold tenants lock through the entire operation to prevent TOCTOU orphan nodes.
        // Lock ordering: tenants → machine_key_index → nodes → preauth_keys
        let mut tenants = self.tenants.lock().unwrap_or_else(|e| e.into_inner());

        // Check for children first
        let has_children = tenants.values().any(|t| t.parent_id == Some(tenant_id));
        if has_children {
            return Err(CoordError::Protocol(
                "cannot delete tenant with children".into(),
            ));
        }

        if tenants.remove(&tenant_id).is_none() {
            return Err(CoordError::TenantNotFound(tenant_id));
        }

        // Remove all nodes belonging to this tenant under the same lock scope.
        let mut machine_index = self.machine_key_index.lock().unwrap_or_else(|e| e.into_inner());
        let mut nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());

        let removed_node_ids: Vec<(NodeId, [u8; 32])> = nodes
            .iter()
            .filter(|(_, n)| n.tenant_id == tenant_id)
            .map(|(nid, _)| {
                let nid = *nid;
                // find the machine key for this node
                let mkey = machine_index
                    .iter()
                    .find(|(_, v)| **v == nid)
                    .map(|(k, _)| *k)
                    .unwrap_or([0u8; 32]);
                (nid, mkey)
            })
            .collect();

        for (nid, mkey) in &removed_node_ids {
            nodes.remove(nid);
            if *mkey != [0u8; 32] {
                machine_index.remove(mkey);
            }
        }

        // Remove preauth keys for this tenant
        let mut keys = self.preauth_keys.lock().unwrap_or_else(|e| e.into_inner());
        keys.retain(|_, v| v.tenant_id != tenant_id);

        // Drop all locks before broadcasting events
        drop(keys);
        drop(nodes);
        drop(machine_index);
        drop(tenants);

        // Broadcast NodeOffline for each removed node
        for (nid, _) in removed_node_ids {
            let _ = self.peer_tx.send(PeerEvent::NodeOffline {
                tenant_id,
                node_id: nid,
            });
        }

        Ok(())
    }

    pub fn get_child_tenants(&self, parent_id: TenantId) -> Vec<Tenant> {
        let tenants = self.tenants.lock().unwrap_or_else(|e| e.into_inner());
        tenants.values()
            .filter(|t| t.parent_id == Some(parent_id))
            .cloned()
            .collect()
    }

    pub fn update_tenant_posture(
        &self,
        tenant_id: TenantId,
        posture: FederationPosture,
    ) -> Result<Tenant, CoordError> {
        let mut tenants = self.tenants.lock().unwrap_or_else(|e| e.into_inner());
        match tenants.get_mut(&tenant_id) {
            Some(t) => {
                t.federation_posture = posture;
                Ok(t.clone())
            }
            None => Err(CoordError::TenantNotFound(tenant_id)),
        }
    }

    pub fn create_preauth_key(&self, tenant_id: TenantId, reusable: bool) -> Result<String, CoordError> {
        let tenants = self.tenants.lock().unwrap_or_else(|e| e.into_inner());
        if !tenants.contains_key(&tenant_id) {
            return Err(CoordError::TenantNotFound(tenant_id));
        }
        drop(tenants);

        let key = format!("tskey-auth-{}", generate_random_id());
        let mut keys = self.preauth_keys.lock().unwrap_or_else(|e| e.into_inner());
        keys.insert(
            key.clone(),
            PreAuthKey {
                key: key.clone(),
                tenant_id,
                used: false,
                reusable,
                expires_at: None,
            },
        );
        Ok(key)
    }

    pub fn validate_preauth_key(&self, key: &str) -> Option<TenantId> {
        let mut keys = self.preauth_keys.lock().unwrap_or_else(|e| e.into_inner());
        let pak = keys.get_mut(key)?;

        if pak.used && !pak.reusable {
            return None;
        }
        if let Some(expires) = pak.expires_at {
            if chrono::Utc::now() > expires {
                return None;
            }
        }

        pak.used = true;
        Some(pak.tenant_id)
    }

    pub fn register_node(
        &self,
        tenant_id: TenantId,
        machine_key: [u8; 32],
        info: NodeInfo,
    ) -> Result<(NodeId, Ipv4Addr, u64), CoordError> {
        let mut machine_index = self.machine_key_index.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(&existing_id) = machine_index.get(&machine_key) {
            let mut nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(node) = nodes.get_mut(&existing_id) {
                if node.tenant_id != tenant_id {
                    return Err(CoordError::Protocol(
                        "machine key already registered to a different tenant".into(),
                    ));
                }
                node.info = info;
                node.online = true;
                node.session_generation += 1;
                let ipv4 = node.ipv4;
                let tid = node.tenant_id;
                let generation = node.session_generation;
                drop(nodes);
                drop(machine_index);
                let _ = self.peer_tx.send(PeerEvent::NodeUpdated {
                    tenant_id: tid,
                    node_id: existing_id,
                });
                return Ok((existing_id, ipv4, generation));
            }
        }

        let node_id = {
            let mut id = self.next_node_id.lock().unwrap_or_else(|e| e.into_inner());
            let current = *id;
            *id = current.checked_add(1).ok_or_else(|| {
                CoordError::Protocol("node ID space exhausted".into())
            })?;
            NodeId::new(current)
        };

        let ipv4 = {
            let mut ip = self.next_ipv4.lock().unwrap_or_else(|e| e.into_inner());
            let current = *ip;
            let max_cgnat = u32::from(Ipv4Addr::new(100, 127, 255, 255));
            if current > max_cgnat {
                return Err(CoordError::AddressSpaceExhausted);
            }
            *ip += 1;
            Ipv4Addr::from(current)
        };

        let stable_id = generate_random_id();

        let stored = StoredNode {
            id: node_id,
            tenant_id,
            info,
            ipv4,
            stable_id,
            online: true,
            session_generation: 1,
            registered_at: chrono::Utc::now(),
        };

        let mut nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
        nodes.insert(node_id, stored);
        machine_index.insert(machine_key, node_id);
        drop(nodes);
        drop(machine_index);

        let _ = self.peer_tx.send(PeerEvent::NodeJoined {
            tenant_id,
            node_id,
        });

        Ok((node_id, ipv4, 1))
    }

    pub fn rotate_node_key(
        &self,
        machine_key: &[u8; 32],
        _old_node_key: &[u8; 32],
        new_node_key: &[u8; 32],
    ) {
        let machine_index = self.machine_key_index.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(&node_id) = machine_index.get(machine_key) {
            drop(machine_index);
            let mut nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(node) = nodes.get_mut(&node_id) {
                node.info.node_key = new_node_key.to_vec();
                let tid = node.tenant_id;
                drop(nodes);
                let _ = self.peer_tx.send(PeerEvent::NodeUpdated {
                    tenant_id: tid,
                    node_id,
                });
            }
        }
    }

    pub fn update_endpoints(
        &self,
        node_id: NodeId,
        endpoints: Vec<String>,
        disco_key: Option<String>,
    ) {
        let mut nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(node) = nodes.get_mut(&node_id) {
            if !endpoints.is_empty() {
                node.info.endpoints = endpoints;
            }
            if let Some(dk) = disco_key {
                node.info.disco_key = Some(dk);
            }
            let tid = node.tenant_id;
            drop(nodes);
            let _ = self.peer_tx.send(PeerEvent::NodeUpdated {
                tenant_id: tid,
                node_id,
            });
        }
    }

    pub fn get_node_by_machine_key(&self, machine_key: &[u8; 32]) -> Option<NodeId> {
        let index = self.machine_key_index.lock().unwrap_or_else(|e| e.into_inner());
        index.get(machine_key).copied()
    }

    pub fn get_peers(&self, tenant_id: TenantId, exclude_node: NodeId) -> Vec<PeerInfo> {
        let nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
        nodes
            .values()
            .filter(|n| n.tenant_id == tenant_id && n.id != exclude_node)
            .map(|n| PeerInfo {
                node_id: n.id,
                node_key: n.info.node_key.clone(),
                disco_key: n.info.disco_key.clone(),
                endpoints: n.info.endpoints.clone(),
                allowed_ips: vec![format!("{}/32", n.ipv4)],
                hostname: n.info.hostname.clone(),
                derp_region: Some(1),
                online: n.online,
                last_seen: Some(n.registered_at),
            })
            .collect()
    }

    pub fn get_peers_with_children(
        &self,
        tenant_id: TenantId,
        exclude_node: NodeId,
    ) -> Vec<PeerInfo> {
        // Hold both locks simultaneously to prevent TOCTOU races on posture changes.
        // Lock ordering: always tenants before nodes.
        let tenants = self.tenants.lock().unwrap_or_else(|e| e.into_inner());
        let nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());

        let child_ids: Vec<TenantId> = tenants
            .values()
            .filter(|t| {
                t.parent_id == Some(tenant_id)
                    && t.federation_posture != FederationPosture::Closed
            })
            .map(|t| t.id)
            .collect();

        let result = nodes
            .values()
            .filter(|n| {
                n.id != exclude_node
                    && (n.tenant_id == tenant_id || child_ids.contains(&n.tenant_id))
            })
            .map(|n| PeerInfo {
                node_id: n.id,
                node_key: n.info.node_key.clone(),
                disco_key: n.info.disco_key.clone(),
                endpoints: n.info.endpoints.clone(),
                allowed_ips: vec![format!("{}/32", n.ipv4)],
                hostname: n.info.hostname.clone(),
                derp_region: Some(1),
                online: n.online,
                last_seen: Some(n.registered_at),
            })
            .collect();

        drop(nodes);
        drop(tenants);
        result
    }

    pub fn list_tenant_nodes(&self, tenant_id: TenantId) -> Vec<PeerInfo> {
        let nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
        nodes
            .values()
            .filter(|n| n.tenant_id == tenant_id)
            .map(|n| PeerInfo {
                node_id: n.id,
                node_key: n.info.node_key.clone(),
                disco_key: n.info.disco_key.clone(),
                endpoints: n.info.endpoints.clone(),
                allowed_ips: vec![format!("{}/32", n.ipv4)],
                hostname: n.info.hostname.clone(),
                derp_region: Some(1),
                online: n.online,
                last_seen: Some(n.registered_at),
            })
            .collect()
    }

    pub fn list_nodes_for_tenant(&self, tenant_id: TenantId) -> Vec<(NodeId, TenantId, Ipv4Addr, String, bool, String)> {
        let nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
        nodes
            .values()
            .filter(|n| n.tenant_id == tenant_id)
            .map(|n| (n.id, n.tenant_id, n.ipv4, n.stable_id.clone(), n.online, n.info.hostname.clone()))
            .collect()
    }

    pub fn get_node_info(&self, node_id: NodeId) -> Option<(TenantId, Ipv4Addr, String, NodeInfo)> {
        let nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
        nodes.get(&node_id).map(|n| {
            (n.tenant_id, n.ipv4, n.stable_id.clone(), n.info.clone())
        })
    }

    pub fn get_node_ipv4(&self, node_id: NodeId) -> Option<Ipv4Addr> {
        let nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
        nodes.get(&node_id).map(|n| n.ipv4)
    }

    pub fn get_node_stable_id(&self, node_id: NodeId) -> Option<String> {
        let nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
        nodes.get(&node_id).map(|n| n.stable_id.clone())
    }

    pub fn get_node_tenant(&self, node_id: NodeId) -> Option<TenantId> {
        let nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
        nodes.get(&node_id).map(|n| n.tenant_id)
    }

    pub fn list_nodes(&self) -> Vec<(NodeId, TenantId, Ipv4Addr, String, bool, String)> {
        let nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
        nodes
            .values()
            .map(|n| (n.id, n.tenant_id, n.ipv4, n.stable_id.clone(), n.online, n.info.hostname.clone()))
            .collect()
    }

    pub fn delete_node(&self, node_id: NodeId) -> Result<TenantId, CoordError> {
        // Lock ordering: machine_key_index before nodes (matches register_node).
        let mut machine_index = self.machine_key_index.lock().unwrap_or_else(|e| e.into_inner());
        let mut nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
        let node = nodes.remove(&node_id)
            .ok_or(CoordError::Protocol("node not found".into()))?;
        let tid = node.tenant_id;

        // Remove from machine key index
        let mkey: Vec<u8> = node.info.machine_key.clone();
        if mkey.len() == 32 {
            let mut key = [0u8; 32];
            key.copy_from_slice(&mkey);
            machine_index.remove(&key);
        }
        drop(nodes);
        drop(machine_index);

        let _ = self.peer_tx.send(PeerEvent::NodeOffline { tenant_id: tid, node_id });
        Ok(tid)
    }

    pub fn rename_node(&self, node_id: NodeId, new_name: String) -> Result<(), CoordError> {
        let mut nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
        let node = nodes.get_mut(&node_id)
            .ok_or(CoordError::Protocol("node not found".into()))?;
        node.info.hostname = new_name;
        let tid = node.tenant_id;
        drop(nodes);
        let _ = self.peer_tx.send(PeerEvent::NodeUpdated { tenant_id: tid, node_id });
        Ok(())
    }

    pub fn set_node_online(&self, node_id: NodeId, online: bool) {
        let mut nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(node) = nodes.get_mut(&node_id) {
            node.online = online;
            let tid = node.tenant_id;
            drop(nodes);
            if online {
                let _ = self.peer_tx.send(PeerEvent::NodeUpdated {
                    tenant_id: tid,
                    node_id,
                });
            } else {
                let _ = self.peer_tx.send(PeerEvent::NodeOffline {
                    tenant_id: tid,
                    node_id,
                });
            }
        }
    }

    pub fn set_node_offline_if_current(&self, node_id: NodeId, generation: u64) {
        let mut nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(node) = nodes.get_mut(&node_id) {
            if node.session_generation != generation {
                return;
            }
            node.online = false;
            let tid = node.tenant_id;
            drop(nodes);
            let _ = self.peer_tx.send(PeerEvent::NodeOffline {
                tenant_id: tid,
                node_id,
            });
        }
    }

    /// Atomically snapshot a tenant's routes: own nodes + children + visible child
    /// nodes, all under a single lock scope to prevent posture/nodes interleaving.
    pub fn get_tenant_route_snapshot(
        &self,
        tenant_id: TenantId,
    ) -> Result<TenantRouteSnapshot, CoordError> {
        // Lock ordering: tenants before nodes (matches get_peers_with_children).
        let tenants = self.tenants.lock().unwrap_or_else(|e| e.into_inner());
        let nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());

        if !tenants.contains_key(&tenant_id) {
            return Err(CoordError::TenantNotFound(tenant_id));
        }

        let children: Vec<Tenant> = tenants
            .values()
            .filter(|t| t.parent_id == Some(tenant_id))
            .cloned()
            .collect();

        let own_nodes: Vec<PeerInfo> = nodes
            .values()
            .filter(|n| n.tenant_id == tenant_id)
            .map(stored_node_to_peer_info)
            .collect();

        let visible_child_nodes: Vec<(TenantId, String, Vec<PeerInfo>)> = children
            .iter()
            .filter(|c| c.federation_posture != FederationPosture::Closed)
            .map(|c| {
                let child_nodes: Vec<PeerInfo> = nodes
                    .values()
                    .filter(|n| n.tenant_id == c.id)
                    .map(stored_node_to_peer_info)
                    .collect();
                (c.id, c.slug.clone(), child_nodes)
            })
            .collect();

        Ok(TenantRouteSnapshot {
            children,
            own_nodes,
            visible_child_nodes,
        })
    }

    #[doc(hidden)]
    pub fn tenants_for_test(&self) -> &Mutex<HashMap<TenantId, Tenant>> {
        &self.tenants
    }
}

/// Snapshot of a tenant's route data, gathered atomically.
#[derive(Debug)]
pub struct TenantRouteSnapshot {
    pub children: Vec<Tenant>,
    pub own_nodes: Vec<PeerInfo>,
    /// (child_tenant_id, child_slug, child_nodes) for non-Closed children only.
    pub visible_child_nodes: Vec<(TenantId, String, Vec<PeerInfo>)>,
}

fn stored_node_to_peer_info(n: &StoredNode) -> PeerInfo {
    PeerInfo {
        node_id: n.id,
        node_key: n.info.node_key.clone(),
        disco_key: n.info.disco_key.clone(),
        endpoints: n.info.endpoints.clone(),
        allowed_ips: vec![format!("{}/32", n.ipv4)],
        hostname: n.info.hostname.clone(),
        derp_region: Some(1),
        online: n.online,
        last_seen: Some(n.registered_at),
    }
}

impl Default for MemoryStore {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for MemoryStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MemoryStore").finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preauth_key_single_use() {
        let store = MemoryStore::new();
        let t = store.create_tenant("single-use".into(), None).unwrap();
        let key = store.create_preauth_key(t.id, false).unwrap();

        assert_eq!(store.validate_preauth_key(&key), Some(t.id));
        assert_eq!(store.validate_preauth_key(&key), None);
    }

    #[test]
    fn preauth_key_reusable() {
        let store = MemoryStore::new();
        let t = store.create_tenant("reusable".into(), None).unwrap();
        let key = store.create_preauth_key(t.id, true).unwrap();

        assert_eq!(store.validate_preauth_key(&key), Some(t.id));
        assert_eq!(store.validate_preauth_key(&key), Some(t.id));
    }

    #[test]
    fn preauth_key_rejected_for_missing_tenant() {
        let store = MemoryStore::new();
        let fake_tid = TenantId::generate();
        let result = store.create_preauth_key(fake_tid, false);
        assert!(result.is_err());
    }

    #[test]
    fn node_registration_assigns_unique_ips() {
        let store = MemoryStore::new();
        let tenant = TenantId::generate();

        let info1 = NodeInfo {
            node_key: vec![1; 32],
            machine_key: vec![1; 32],
            disco_key: None,
            endpoints: vec![],
            hostname: "node1".into(),
            os: "linux".into(),
            ipv4: None,
            ipv6: None,
        };
        let info2 = NodeInfo {
            node_key: vec![2; 32],
            machine_key: vec![2; 32],
            disco_key: None,
            endpoints: vec![],
            hostname: "node2".into(),
            os: "linux".into(),
            ipv4: None,
            ipv6: None,
        };

        let (id1, ip1, _) = store.register_node(tenant, [1u8; 32], info1).unwrap();
        let (id2, ip2, _) = store.register_node(tenant, [2u8; 32], info2).unwrap();

        assert_ne!(id1, id2);
        assert_ne!(ip1, ip2);
    }

    #[test]
    fn re_registration_reuses_node() {
        let store = MemoryStore::new();
        let tenant = TenantId::generate();
        let mkey = [42u8; 32];

        let info = NodeInfo {
            node_key: vec![1; 32],
            machine_key: vec![42; 32],
            disco_key: None,
            endpoints: vec![],
            hostname: "node1".into(),
            os: "linux".into(),
            ipv4: None,
            ipv6: None,
        };

        let (id1, ip1, gen1) = store.register_node(tenant, mkey, info.clone()).unwrap();
        let (id2, ip2, gen2) = store.register_node(tenant, mkey, info).unwrap();

        assert_eq!(id1, id2);
        assert_eq!(ip1, ip2);
        assert!(gen2 > gen1, "generation should increment on re-register");
    }

    #[test]
    fn peers_exclude_requesting_node() {
        let store = MemoryStore::new();
        let tenant = TenantId::generate();

        let info1 = NodeInfo {
            node_key: vec![1; 32],
            machine_key: vec![1; 32],
            disco_key: None,
            endpoints: vec![],
            hostname: "node1".into(),
            os: "linux".into(),
            ipv4: None,
            ipv6: None,
        };
        let info2 = NodeInfo {
            node_key: vec![2; 32],
            machine_key: vec![2; 32],
            disco_key: None,
            endpoints: vec![],
            hostname: "node2".into(),
            os: "linux".into(),
            ipv4: None,
            ipv6: None,
        };

        let (id1, _, _) = store.register_node(tenant, [1u8; 32], info1).unwrap();
        let (_, _, _) = store.register_node(tenant, [2u8; 32], info2).unwrap();

        let peers = store.get_peers(tenant, id1);
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].hostname, "node2");
    }

    #[test]
    fn tenant_isolation() {
        let store = MemoryStore::new();
        let t1 = TenantId::generate();
        let t2 = TenantId::generate();

        let info1 = NodeInfo {
            node_key: vec![1; 32],
            machine_key: vec![1; 32],
            disco_key: None,
            endpoints: vec![],
            hostname: "t1-node".into(),
            os: "linux".into(),
            ipv4: None,
            ipv6: None,
        };
        let info2 = NodeInfo {
            node_key: vec![2; 32],
            machine_key: vec![2; 32],
            disco_key: None,
            endpoints: vec![],
            hostname: "t2-node".into(),
            os: "linux".into(),
            ipv4: None,
            ipv6: None,
        };

        let (id1, _, _) = store.register_node(t1, [1u8; 32], info1).unwrap();
        let (_, _, _) = store.register_node(t2, [2u8; 32], info2).unwrap();

        let peers = store.get_peers(t1, id1);
        assert_eq!(peers.len(), 0);
    }

    #[test]
    fn cross_tenant_reregistration_rejected() {
        let store = MemoryStore::new();
        let t1 = TenantId::generate();
        let t2 = TenantId::generate();
        let mkey = [99u8; 32];

        let info = NodeInfo {
            node_key: vec![1; 32],
            machine_key: vec![99; 32],
            disco_key: None,
            endpoints: vec![],
            hostname: "cross-node".into(),
            os: "linux".into(),
            ipv4: None,
            ipv6: None,
        };

        // First registration succeeds
        store.register_node(t1, mkey, info.clone()).unwrap();

        // Re-registration with different tenant must fail
        let result = store.register_node(t2, mkey, info);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.to_string().contains("different tenant"),
            "error should mention different tenant, got: {}",
            err
        );
    }

    #[tokio::test]
    async fn peer_events_broadcast() {
        let store = MemoryStore::new();
        let mut rx = store.subscribe();
        let tenant = TenantId::generate();

        let info = NodeInfo {
            node_key: vec![1; 32],
            machine_key: vec![1; 32],
            disco_key: None,
            endpoints: vec![],
            hostname: "event-node".into(),
            os: "linux".into(),
            ipv4: None,
            ipv6: None,
        };

        let (node_id, _, _) = store.register_node(tenant, [1u8; 32], info).unwrap();

        let event = rx.try_recv().unwrap();
        match event {
            PeerEvent::NodeJoined { tenant_id, node_id: nid } => {
                assert_eq!(tenant_id, tenant);
                assert_eq!(nid, node_id);
            }
            _ => panic!("expected NodeJoined"),
        }

        store.set_node_online(node_id, false);
        let event = rx.try_recv().unwrap();
        match event {
            PeerEvent::NodeOffline { node_id: nid, .. } => {
                assert_eq!(nid, node_id);
            }
            _ => panic!("expected NodeOffline"),
        }
    }
}
