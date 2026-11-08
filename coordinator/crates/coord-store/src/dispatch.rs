use std::net::Ipv4Addr;
use tokio::sync::broadcast;

use coord_core::{CoordError, NodeId, NodeInfo, PeerInfo, Tenant, TenantId};
use tracing::warn;
use crate::memory::{MemoryStore, PeerEvent};
use crate::pg::PgStore;

pub enum Store {
    Memory(MemoryStore),
    Pg(PgStore),
}

impl Store {
    pub fn subscribe(&self) -> broadcast::Receiver<PeerEvent> {
        match self {
            Store::Memory(m) => m.subscribe(),
            Store::Pg(p) => p.subscribe(),
        }
    }

    pub async fn create_tenant(
        &self,
        slug: String,
        parent_id: Option<TenantId>,
    ) -> Result<Tenant, CoordError> {
        match self {
            Store::Memory(m) => m.create_tenant(slug, parent_id),
            Store::Pg(p) => p.create_tenant(slug, parent_id).await,
        }
    }

    pub async fn get_tenant(&self, tenant_id: TenantId) -> Option<Tenant> {
        match self {
            Store::Memory(m) => m.get_tenant(tenant_id),
            Store::Pg(p) => p.get_tenant(tenant_id).await,
        }
    }

    pub async fn list_tenants(&self) -> Vec<Tenant> {
        match self {
            Store::Memory(m) => m.list_tenants(),
            Store::Pg(p) => p.list_tenants().await,
        }
    }

    pub async fn delete_tenant(&self, tenant_id: TenantId) -> Result<(), CoordError> {
        match self {
            Store::Memory(m) => m.delete_tenant(tenant_id),
            Store::Pg(p) => p.delete_tenant(tenant_id).await,
        }
    }

    pub async fn get_child_tenants(&self, parent_id: TenantId) -> Vec<Tenant> {
        match self {
            Store::Memory(m) => m.get_child_tenants(parent_id),
            Store::Pg(p) => p.get_child_tenants(parent_id).await,
        }
    }

    pub async fn create_preauth_key(&self, tenant_id: TenantId, reusable: bool) -> Result<String, CoordError> {
        match self {
            Store::Memory(m) => m.create_preauth_key(tenant_id, reusable),
            Store::Pg(p) => p.create_preauth_key(tenant_id, reusable).await,
        }
    }

    pub async fn validate_preauth_key(&self, key: &str) -> Option<TenantId> {
        match self {
            Store::Memory(m) => m.validate_preauth_key(key),
            Store::Pg(p) => p.validate_preauth_key(key).await,
        }
    }

    pub async fn register_node(
        &self,
        tenant_id: TenantId,
        machine_key: [u8; 32],
        info: NodeInfo,
    ) -> Result<(NodeId, Ipv4Addr, u64), CoordError> {
        match self {
            Store::Memory(m) => m.register_node(tenant_id, machine_key, info),
            Store::Pg(p) => p.register_node(tenant_id, machine_key, info).await,
        }
    }

    pub async fn rotate_node_key(
        &self,
        machine_key: &[u8; 32],
        old_node_key: &[u8; 32],
        new_node_key: &[u8; 32],
    ) {
        let result = match self {
            Store::Memory(m) => { m.rotate_node_key(machine_key, old_node_key, new_node_key); Ok(()) },
            Store::Pg(p) => p.rotate_node_key(machine_key, old_node_key, new_node_key).await,
        };
        if let Err(e) = result {
            warn!(error = %e, "rotate_node_key failed");
        }
    }

    pub async fn update_endpoints(
        &self,
        node_id: NodeId,
        endpoints: Vec<String>,
        disco_key: Option<String>,
    ) {
        let result = match self {
            Store::Memory(m) => { m.update_endpoints(node_id, endpoints, disco_key); Ok(()) },
            Store::Pg(p) => p.update_endpoints(node_id, endpoints, disco_key).await,
        };
        if let Err(e) = result {
            warn!(error = %e, "update_endpoints failed");
        }
    }

    pub async fn get_node_by_machine_key(&self, machine_key: &[u8; 32]) -> Option<NodeId> {
        match self {
            Store::Memory(m) => m.get_node_by_machine_key(machine_key),
            Store::Pg(p) => p.get_node_by_machine_key(machine_key).await,
        }
    }

    pub async fn get_peers(&self, tenant_id: TenantId, exclude_node: NodeId) -> Vec<PeerInfo> {
        match self {
            Store::Memory(m) => m.get_peers(tenant_id, exclude_node),
            Store::Pg(p) => p.get_peers(tenant_id, exclude_node).await,
        }
    }

    pub async fn get_peers_with_children(
        &self,
        tenant_id: TenantId,
        exclude_node: NodeId,
    ) -> Vec<PeerInfo> {
        match self {
            Store::Memory(m) => m.get_peers_with_children(tenant_id, exclude_node),
            Store::Pg(p) => p.get_peers_with_children(tenant_id, exclude_node).await,
        }
    }

    pub async fn list_tenant_nodes(&self, tenant_id: TenantId) -> Vec<PeerInfo> {
        match self {
            Store::Memory(m) => m.list_tenant_nodes(tenant_id),
            Store::Pg(p) => p.list_tenant_nodes(tenant_id).await,
        }
    }

    pub async fn list_nodes_for_tenant(&self, tenant_id: TenantId) -> Vec<(NodeId, TenantId, Ipv4Addr, String, bool, String)> {
        match self {
            Store::Memory(m) => m.list_nodes_for_tenant(tenant_id),
            Store::Pg(p) => p.list_nodes_for_tenant(tenant_id).await,
        }
    }

    pub async fn get_node_info(
        &self,
        node_id: NodeId,
    ) -> Option<(TenantId, Ipv4Addr, String, NodeInfo)> {
        match self {
            Store::Memory(m) => m.get_node_info(node_id),
            Store::Pg(p) => p.get_node_info(node_id).await,
        }
    }

    pub async fn get_node_ipv4(&self, node_id: NodeId) -> Option<Ipv4Addr> {
        match self {
            Store::Memory(m) => m.get_node_ipv4(node_id),
            Store::Pg(p) => p.get_node_ipv4(node_id).await,
        }
    }

    pub async fn get_node_stable_id(&self, node_id: NodeId) -> Option<String> {
        match self {
            Store::Memory(m) => m.get_node_stable_id(node_id),
            Store::Pg(p) => p.get_node_stable_id(node_id).await,
        }
    }

    pub async fn get_node_tenant(&self, node_id: NodeId) -> Option<TenantId> {
        match self {
            Store::Memory(m) => m.get_node_tenant(node_id),
            Store::Pg(p) => p.get_node_tenant(node_id).await,
        }
    }

    pub async fn list_nodes(&self) -> Vec<(NodeId, TenantId, Ipv4Addr, String, bool, String)> {
        match self {
            Store::Memory(m) => m.list_nodes(),
            Store::Pg(p) => p.list_nodes().await,
        }
    }

    pub async fn delete_node(&self, node_id: NodeId) -> Result<TenantId, CoordError> {
        match self {
            Store::Memory(m) => m.delete_node(node_id),
            Store::Pg(p) => p.delete_node(node_id).await,
        }
    }

    pub async fn rename_node(&self, node_id: NodeId, new_name: String) -> Result<(), CoordError> {
        match self {
            Store::Memory(m) => m.rename_node(node_id, new_name),
            Store::Pg(p) => p.rename_node(node_id, new_name).await,
        }
    }

    pub async fn set_node_online(&self, node_id: NodeId, online: bool) {
        let result = match self {
            Store::Memory(m) => { m.set_node_online(node_id, online); Ok(()) },
            Store::Pg(p) => p.set_node_online(node_id, online).await,
        };
        if let Err(e) = result {
            warn!(error = %e, "set_node_online failed");
        }
    }

    pub async fn set_node_offline_if_current(&self, node_id: NodeId, generation: u64) {
        let result = match self {
            Store::Memory(m) => { m.set_node_offline_if_current(node_id, generation); Ok(()) },
            Store::Pg(p) => p.set_node_offline_if_current(node_id, generation).await,
        };
        if let Err(e) = result {
            warn!(error = %e, "set_node_offline_if_current failed");
        }
    }
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Store::Memory(m) => m.fmt(f),
            Store::Pg(p) => p.fmt(f),
        }
    }
}
