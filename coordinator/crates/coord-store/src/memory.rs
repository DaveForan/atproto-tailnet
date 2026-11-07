use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::Mutex;
use tokio::sync::broadcast;

use coord_core::{NodeId, NodeInfo, PeerInfo, TenantId};

#[derive(Debug, Clone)]
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
    nodes: Mutex<HashMap<NodeId, StoredNode>>,
    machine_key_index: Mutex<HashMap<[u8; 32], NodeId>>,
    preauth_keys: Mutex<HashMap<String, PreAuthKey>>,
    next_node_id: Mutex<i64>,
    next_ipv4: Mutex<u32>,
    peer_tx: broadcast::Sender<PeerEvent>,
}

impl MemoryStore {
    pub fn new() -> Self {
        let (peer_tx, _) = broadcast::channel(256);
        Self {
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

    pub fn create_preauth_key(&self, tenant_id: TenantId, reusable: bool) -> String {
        let key = format!("tskey-auth-{}", generate_random_id());
        let mut keys = self.preauth_keys.lock().unwrap();
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
        key
    }

    pub fn validate_preauth_key(&self, key: &str) -> Option<TenantId> {
        let mut keys = self.preauth_keys.lock().unwrap();
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
    ) -> (NodeId, Ipv4Addr) {
        let mut machine_index = self.machine_key_index.lock().unwrap();
        if let Some(&existing_id) = machine_index.get(&machine_key) {
            let mut nodes = self.nodes.lock().unwrap();
            if let Some(node) = nodes.get_mut(&existing_id) {
                node.info = info;
                node.online = true;
                let ipv4 = node.ipv4;
                let tid = node.tenant_id;
                drop(nodes);
                drop(machine_index);
                let _ = self.peer_tx.send(PeerEvent::NodeUpdated {
                    tenant_id: tid,
                    node_id: existing_id,
                });
                return (existing_id, ipv4);
            }
        }

        let node_id = {
            let mut id = self.next_node_id.lock().unwrap();
            let current = *id;
            *id += 1;
            NodeId::new(current)
        };

        let ipv4 = {
            let mut ip = self.next_ipv4.lock().unwrap();
            let current = *ip;
            let max_cgnat = u32::from(Ipv4Addr::new(100, 127, 255, 255));
            assert!(current <= max_cgnat, "CGNAT address space exhausted");
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
            registered_at: chrono::Utc::now(),
        };

        let mut nodes = self.nodes.lock().unwrap();
        nodes.insert(node_id, stored);
        machine_index.insert(machine_key, node_id);
        drop(nodes);
        drop(machine_index);

        let _ = self.peer_tx.send(PeerEvent::NodeJoined {
            tenant_id,
            node_id,
        });

        (node_id, ipv4)
    }

    pub fn rotate_node_key(
        &self,
        machine_key: &[u8; 32],
        _old_node_key: &[u8; 32],
        new_node_key: &[u8; 32],
    ) {
        let machine_index = self.machine_key_index.lock().unwrap();
        if let Some(&node_id) = machine_index.get(machine_key) {
            drop(machine_index);
            let mut nodes = self.nodes.lock().unwrap();
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
        let mut nodes = self.nodes.lock().unwrap();
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
        let index = self.machine_key_index.lock().unwrap();
        index.get(machine_key).copied()
    }

    pub fn get_peers(&self, tenant_id: TenantId, exclude_node: NodeId) -> Vec<PeerInfo> {
        let nodes = self.nodes.lock().unwrap();
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

    pub fn get_node_info(&self, node_id: NodeId) -> Option<(TenantId, Ipv4Addr, String, NodeInfo)> {
        let nodes = self.nodes.lock().unwrap();
        nodes.get(&node_id).map(|n| {
            (n.tenant_id, n.ipv4, n.stable_id.clone(), n.info.clone())
        })
    }

    pub fn get_node_ipv4(&self, node_id: NodeId) -> Option<Ipv4Addr> {
        let nodes = self.nodes.lock().unwrap();
        nodes.get(&node_id).map(|n| n.ipv4)
    }

    pub fn get_node_stable_id(&self, node_id: NodeId) -> Option<String> {
        let nodes = self.nodes.lock().unwrap();
        nodes.get(&node_id).map(|n| n.stable_id.clone())
    }

    pub fn get_node_tenant(&self, node_id: NodeId) -> Option<TenantId> {
        let nodes = self.nodes.lock().unwrap();
        nodes.get(&node_id).map(|n| n.tenant_id)
    }

    pub fn list_nodes(&self) -> Vec<(NodeId, TenantId, Ipv4Addr, String, bool, String)> {
        let nodes = self.nodes.lock().unwrap();
        nodes
            .values()
            .map(|n| (n.id, n.tenant_id, n.ipv4, n.stable_id.clone(), n.online, n.info.hostname.clone()))
            .collect()
    }

    pub fn set_node_online(&self, node_id: NodeId, online: bool) {
        let mut nodes = self.nodes.lock().unwrap();
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
}

impl std::fmt::Debug for MemoryStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MemoryStore").finish()
    }
}

fn generate_random_id() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 8];
    rand::rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preauth_key_single_use() {
        let store = MemoryStore::new();
        let tenant = TenantId::generate();
        let key = store.create_preauth_key(tenant, false);

        assert_eq!(store.validate_preauth_key(&key), Some(tenant));
        assert_eq!(store.validate_preauth_key(&key), None);
    }

    #[test]
    fn preauth_key_reusable() {
        let store = MemoryStore::new();
        let tenant = TenantId::generate();
        let key = store.create_preauth_key(tenant, true);

        assert_eq!(store.validate_preauth_key(&key), Some(tenant));
        assert_eq!(store.validate_preauth_key(&key), Some(tenant));
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

        let (id1, ip1) = store.register_node(tenant, [1u8; 32], info1);
        let (id2, ip2) = store.register_node(tenant, [2u8; 32], info2);

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

        let (id1, ip1) = store.register_node(tenant, mkey, info.clone());
        let (id2, ip2) = store.register_node(tenant, mkey, info);

        assert_eq!(id1, id2);
        assert_eq!(ip1, ip2);
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

        let (id1, _) = store.register_node(tenant, [1u8; 32], info1);
        let (_, _) = store.register_node(tenant, [2u8; 32], info2);

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

        let (id1, _) = store.register_node(t1, [1u8; 32], info1);
        let (_, _) = store.register_node(t2, [2u8; 32], info2);

        let peers = store.get_peers(t1, id1);
        assert_eq!(peers.len(), 0);
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

        let (node_id, _) = store.register_node(tenant, [1u8; 32], info);

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
