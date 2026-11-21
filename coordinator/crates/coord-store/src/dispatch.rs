use std::net::Ipv4Addr;
use tokio::sync::broadcast;

use coord_core::{
    CoordError, CreatedPreAuthKey, FederationPosture, NodeDetail, NodeId, NodeInfo, NodeRegistration,
    NodeSummary, PeerInfo, PreAuthGrant, PreAuthKeyInfo, PreAuthKeyOptions, Tenant, TenantId,
};
use crate::memory::{MemoryStore, PeerEvent};
use crate::pg::PgStore;
use crate::sqlite::SqliteStore;

pub enum Store {
    Memory(Box<MemoryStore>),
    Pg(PgStore),
    Sqlite(SqliteStore),
}

impl Store {
    pub fn subscribe(&self) -> broadcast::Receiver<PeerEvent> {
        match self {
            Store::Memory(m) => m.subscribe(),
            Store::Pg(p) => p.subscribe(),
            Store::Sqlite(s) => s.subscribe(),
        }
    }

    pub async fn create_tenant(
        &self,
        slug: String,
        parent_id: Option<TenantId>,
        posture: Option<FederationPosture>,
    ) -> Result<Tenant, CoordError> {
        match self {
            Store::Memory(m) => m.create_tenant(slug, parent_id, posture),
            Store::Pg(p) => p.create_tenant(slug, parent_id, posture).await,
            Store::Sqlite(s) => s.create_tenant(slug, parent_id, posture).await,
        }
    }

    pub async fn get_tenant(&self, tenant_id: TenantId) -> Option<Tenant> {
        match self {
            Store::Memory(m) => m.get_tenant(tenant_id),
            Store::Pg(p) => p.get_tenant(tenant_id).await,
            Store::Sqlite(s) => s.get_tenant(tenant_id).await,
        }
    }

    pub async fn list_tenants(&self) -> Vec<Tenant> {
        match self {
            Store::Memory(m) => m.list_tenants(),
            Store::Pg(p) => p.list_tenants().await,
            Store::Sqlite(s) => s.list_tenants().await,
        }
    }

    pub async fn delete_tenant(&self, tenant_id: TenantId) -> Result<(), CoordError> {
        match self {
            Store::Memory(m) => m.delete_tenant(tenant_id),
            Store::Pg(p) => p.delete_tenant(tenant_id).await,
            Store::Sqlite(s) => s.delete_tenant(tenant_id).await,
        }
    }

    pub async fn get_child_tenants(&self, parent_id: TenantId) -> Vec<Tenant> {
        match self {
            Store::Memory(m) => m.get_child_tenants(parent_id),
            Store::Pg(p) => p.get_child_tenants(parent_id).await,
            Store::Sqlite(s) => s.get_child_tenants(parent_id).await,
        }
    }

    pub async fn update_tenant_posture(
        &self,
        tenant_id: TenantId,
        posture: FederationPosture,
    ) -> Result<Tenant, CoordError> {
        match self {
            Store::Memory(m) => m.update_tenant_posture(tenant_id, posture),
            Store::Pg(p) => p.update_tenant_posture(tenant_id, posture).await,
            Store::Sqlite(s) => s.update_tenant_posture(tenant_id, posture).await,
        }
    }

    pub async fn set_tenant_suspended(
        &self,
        tenant_id: TenantId,
        suspended: bool,
    ) -> Result<Tenant, CoordError> {
        match self {
            Store::Memory(m) => m.set_tenant_suspended(tenant_id, suspended),
            Store::Pg(p) => p.set_tenant_suspended(tenant_id, suspended).await,
            Store::Sqlite(s) => s.set_tenant_suspended(tenant_id, suspended).await,
        }
    }

    /// True when the tenant exists and is suspended by the instance operator.
    /// The tenant's device access mode and rules (ADR-0036). Defaults to open.
    pub async fn get_tenant_access(&self, tenant_id: TenantId) -> coord_core::TenantAccess {
        match self {
            Store::Memory(m) => m.get_tenant_access(tenant_id),
            Store::Pg(p) => p.get_tenant_access(tenant_id).await,
            Store::Sqlite(s) => s.get_tenant_access(tenant_id).await,
        }
    }

    pub async fn set_tenant_access(
        &self,
        tenant_id: TenantId,
        access: coord_core::TenantAccess,
    ) -> Result<(), CoordError> {
        match self {
            Store::Memory(m) => m.set_tenant_access(tenant_id, access),
            Store::Pg(p) => p.set_tenant_access(tenant_id, access).await,
            Store::Sqlite(s) => s.set_tenant_access(tenant_id, access).await,
        }
    }

    /// The tenant's DNS configuration (ADR-0028). Defaults to off.
    pub async fn get_tenant_dns(&self, tenant_id: TenantId) -> coord_core::TenantDns {
        match self {
            Store::Memory(m) => m.get_tenant_dns(tenant_id),
            Store::Pg(p) => p.get_tenant_dns(tenant_id).await,
            Store::Sqlite(s) => s.get_tenant_dns(tenant_id).await,
        }
    }

    pub async fn set_tenant_dns(&self, tenant_id: TenantId, dns: coord_core::TenantDns) -> Result<(), CoordError> {
        match self {
            Store::Memory(m) => m.set_tenant_dns(tenant_id, dns),
            Store::Pg(p) => p.set_tenant_dns(tenant_id, dns).await,
            Store::Sqlite(s) => s.set_tenant_dns(tenant_id, dns).await,
        }
    }

    /// Events from other replicas (never fires for single-process backends).
    pub fn subscribe_remote(&self) -> broadcast::Receiver<crate::RemoteEvent> {
        match self {
            Store::Memory(m) => m.subscribe_remote(),
            Store::Pg(p) => p.subscribe_remote(),
            Store::Sqlite(s) => s.subscribe_remote(),
        }
    }

    /// Tell the other replicas about an event. The caller handles it locally.
    pub async fn publish(&self, event: crate::RemoteEvent) {
        if let Store::Pg(p) = self {
            p.publish(event).await;
        }
    }

    /// Every stored configuration value of a tenant, as (kind, value).
    pub async fn get_tenant_configs(&self, tenant_id: TenantId) -> Result<Vec<(String, serde_json::Value)>, CoordError> {
        match self {
            Store::Memory(m) => m.get_tenant_configs(tenant_id),
            Store::Pg(p) => p.get_tenant_configs(tenant_id).await,
            Store::Sqlite(s) => s.get_tenant_configs(tenant_id).await,
        }
    }

    /// Every stored configuration value of every tenant.
    pub async fn list_tenant_configs(&self) -> Result<Vec<(TenantId, String, serde_json::Value)>, CoordError> {
        match self {
            Store::Memory(m) => m.list_tenant_configs(),
            Store::Pg(p) => p.list_tenant_configs().await,
            Store::Sqlite(s) => s.list_tenant_configs().await,
        }
    }

    /// Set or (with `None`) remove one configuration value of a tenant.
    pub async fn set_tenant_config(
        &self,
        tenant_id: TenantId,
        kind: &str,
        value: Option<serde_json::Value>,
    ) -> Result<(), CoordError> {
        match self {
            Store::Memory(m) => m.set_tenant_config(tenant_id, kind, value),
            Store::Pg(p) => p.set_tenant_config(tenant_id, kind, value).await,
            Store::Sqlite(s) => s.set_tenant_config(tenant_id, kind, value).await,
        }
    }

    /// Start a pending sign-in unless a cap in `limits` is reached; drops the machine's older pending sign-in.
    pub async fn sign_in_start(
        &self,
        id: &str,
        machine_key: &[u8; 32],
        hostname: &str,
        os: &str,
        requester_ip: Option<&str>,
        limits: coord_core::SignInLimits,
    ) -> Result<coord_core::SignInStart, CoordError> {
        match self {
            Store::Memory(m) => m.sign_in_start(id, machine_key, hostname, os, requester_ip, limits),
            Store::Pg(p) => p.sign_in_start(id, machine_key, hostname, os, requester_ip, limits).await,
            Store::Sqlite(s) => s.sign_in_start(id, machine_key, hostname, os, requester_ip, limits).await,
        }
    }

    /// The sign-in with this id, unless it expired.
    pub async fn sign_in_get(&self, id: &str) -> Option<coord_core::PendingSignIn> {
        match self {
            Store::Memory(m) => m.sign_in_get(id),
            Store::Pg(p) => p.sign_in_get(id).await,
            Store::Sqlite(s) => s.sign_in_get(id).await,
        }
    }

    /// Record the decision. False when unknown, expired or already decided.
    pub async fn sign_in_decide(&self, id: &str, decision: &coord_core::SignInDecision) -> bool {
        match self {
            Store::Memory(m) => m.sign_in_decide(id, decision),
            Store::Pg(p) => p.sign_in_decide(id, decision).await,
            Store::Sqlite(s) => s.sign_in_decide(id, decision).await,
        }
    }

    /// Remove a decided sign-in and return its decision; one caller wins.
    pub async fn sign_in_take(&self, id: &str) -> Option<coord_core::SignInDecision> {
        match self {
            Store::Memory(m) => m.sign_in_take(id),
            Store::Pg(p) => p.sign_in_take(id).await,
            Store::Sqlite(s) => s.sign_in_take(id).await,
        }
    }

    /// A relay process reports that it is alive.
    pub async fn relay_heartbeat(&self, relay: &coord_core::RelayInfo) -> Result<(), CoordError> {
        match self {
            Store::Memory(m) => m.relay_heartbeat(relay),
            Store::Pg(p) => p.relay_heartbeat(relay).await,
            Store::Sqlite(s) => s.relay_heartbeat(relay).await,
        }
    }

    /// Relays seen in the last `max_age_secs` seconds, by region id.
    pub async fn list_relays(&self, max_age_secs: i64) -> Vec<coord_core::RelayInfo> {
        let mut relays = match self {
            Store::Memory(m) => m.list_relays(max_age_secs),
            Store::Pg(p) => p.list_relays(max_age_secs).await,
            Store::Sqlite(s) => s.list_relays(max_age_secs).await,
        };
        relays.sort_by_key(|r| r.region_id);
        relays
    }

    /// Record the relay region a node reports as its home. True when it
    /// changed (peers are then told with a node-updated event).
    pub async fn set_home_relay(&self, node_id: NodeId, region: i32) -> Result<bool, CoordError> {
        match self {
            Store::Memory(m) => m.set_home_relay(node_id, region),
            Store::Pg(p) => p.set_home_relay(node_id, region).await,
            Store::Sqlite(s) => s.set_home_relay(node_id, region).await,
        }
    }

    /// The reported home relay region of each of these nodes that has one.
    pub async fn home_relays(&self, node_ids: &[NodeId]) -> std::collections::HashMap<NodeId, i32> {
        if node_ids.is_empty() {
            return Default::default();
        }
        match self {
            Store::Memory(m) => m.home_relays(node_ids),
            Store::Pg(p) => p.home_relays(node_ids).await,
            Store::Sqlite(s) => s.home_relays(node_ids).await,
        }
    }

    /// The machine lock of an owner in a tenant (ADR-0035). A storage error
    /// is an error (callers refuse: fail closed); an undecodable row is
    /// `LockRead::Malformed`, which counts as locked.
    pub async fn get_owner_lock(&self, tenant_id: TenantId, owner: &str) -> Result<coord_core::LockRead, CoordError> {
        match self {
            Store::Memory(m) => Ok(m.get_owner_lock(tenant_id, owner)),
            Store::Pg(p) => p.get_owner_lock(tenant_id, owner).await,
            Store::Sqlite(s) => s.get_owner_lock(tenant_id, owner).await,
        }
    }

    /// Every well-formed machine lock, as (tenant, owner, lock).
    pub async fn list_owner_locks(&self) -> Vec<(TenantId, String, coord_core::OwnerLock)> {
        match self {
            Store::Memory(m) => m.list_owner_locks(),
            Store::Pg(p) => p.list_owner_locks().await,
            Store::Sqlite(s) => s.list_owner_locks().await,
        }
    }

    /// Read-modify-write one owner's lock atomically: `f` sees the current
    /// lock and decides what to write, and no other update of the same
    /// (tenant, owner) — on this or another replica — can interleave. A
    /// storage error means nothing was written.
    pub async fn update_owner_lock<R, F>(&self, tenant_id: TenantId, owner: &str, f: F) -> Result<R, CoordError>
    where
        F: FnOnce(coord_core::LockRead) -> (coord_core::LockWrite, R) + Send,
        R: Send,
    {
        match self {
            Store::Memory(m) => m.update_owner_lock(tenant_id, owner, f),
            Store::Pg(p) => p.update_owner_lock(tenant_id, owner, f).await,
            Store::Sqlite(s) => s.update_owner_lock(tenant_id, owner, f).await,
        }
    }

    /// Set or (with `None`) remove an owner's machine lock unconditionally.
    pub async fn set_owner_lock(
        &self,
        tenant_id: TenantId,
        owner: &str,
        lock: Option<coord_core::OwnerLock>,
    ) -> Result<(), CoordError> {
        let write = match lock {
            Some(l) => coord_core::LockWrite::Set(l),
            None => coord_core::LockWrite::Remove,
        };
        self.update_owner_lock(tenant_id, owner, move |_| (write, ())).await
    }

    /// Decide whether `machine_key` may register for `owner`, recording the
    /// decision in the lock in the same atomic step (a consumed "allow one"
    /// window, a refused attempt). `Ok(None)` = the owner has no lock.
    pub async fn check_owner_lock(
        &self,
        tenant_id: TenantId,
        owner: &str,
        machine_key: &[u8; 32],
        hostname: &str,
        os: &str,
        fingerprint: &str,
    ) -> Result<Option<coord_core::LockOutcome>, CoordError> {
        let hex_key = hex::encode(machine_key);
        let now = chrono::Utc::now();
        self.update_owner_lock(tenant_id, owner, |read| {
            if read == coord_core::LockRead::Malformed {
                tracing::error!(tenant = %tenant_id, "machine lock is malformed: refusing registration");
            }
            coord_core::lock::registration_check(read, &hex_key, now, hostname, os, fingerprint)
        })
        .await
    }

    pub async fn is_tenant_suspended(&self, tenant_id: TenantId) -> bool {
        self.get_tenant(tenant_id).await.is_some_and(|t| t.suspended)
    }

    pub async fn create_preauth_key(&self, tenant_id: TenantId, reusable: bool) -> Result<String, CoordError> {
        match self {
            Store::Memory(m) => m.create_preauth_key(tenant_id, reusable),
            Store::Pg(p) => p.create_preauth_key(tenant_id, reusable).await,
            Store::Sqlite(s) => s.create_preauth_key(tenant_id, reusable).await,
        }
    }

    /// Tenant a pre-auth key belongs to, without validating or consuming it.
    pub async fn preauth_key_tenant(&self, key: &str) -> Option<TenantId> {
        match self {
            Store::Memory(m) => m.preauth_key_tenant(key),
            Store::Pg(p) => p.preauth_key_tenant(key).await,
            Store::Sqlite(s) => s.preauth_key_tenant(key).await,
        }
    }

    pub async fn validate_preauth_key(&self, key: &str) -> Option<PreAuthGrant> {
        match self {
            Store::Memory(m) => m.validate_preauth_key(key),
            Store::Pg(p) => p.validate_preauth_key(key).await,
            Store::Sqlite(s) => s.validate_preauth_key(key).await,
        }
    }

    pub async fn create_preauth_key_with(&self, tenant_id: TenantId, opts: PreAuthKeyOptions) -> Result<CreatedPreAuthKey, CoordError> {
        match self {
            Store::Memory(m) => m.create_preauth_key_with(tenant_id, opts),
            Store::Pg(p) => p.create_preauth_key_with(tenant_id, opts).await,
            Store::Sqlite(s) => s.create_preauth_key_with(tenant_id, opts).await,
        }
    }

    pub async fn list_preauth_keys(&self, tenant_id: TenantId) -> Vec<PreAuthKeyInfo> {
        match self {
            Store::Memory(m) => m.list_preauth_keys(tenant_id),
            Store::Pg(p) => p.list_preauth_keys(tenant_id).await,
            Store::Sqlite(s) => s.list_preauth_keys(tenant_id).await,
        }
    }

    pub async fn revoke_preauth_key(&self, tenant_id: TenantId, key_id: uuid::Uuid) -> Result<bool, CoordError> {
        match self {
            Store::Memory(m) => m.revoke_preauth_key(tenant_id, key_id),
            Store::Pg(p) => p.revoke_preauth_key(tenant_id, key_id).await,
            Store::Sqlite(s) => s.revoke_preauth_key(tenant_id, key_id).await,
        }
    }

    pub async fn revoke_preauth_keys_by_owner(&self, tenant_id: TenantId, owner: &str) -> Result<u64, CoordError> {
        match self {
            Store::Memory(m) => m.revoke_preauth_keys_by_owner(tenant_id, owner),
            Store::Pg(p) => p.revoke_preauth_keys_by_owner(tenant_id, owner).await,
            Store::Sqlite(s) => s.revoke_preauth_keys_by_owner(tenant_id, owner).await,
        }
    }

    pub async fn register_node_with(&self, tenant_id: TenantId, machine_key: [u8; 32], info: NodeInfo, reg: NodeRegistration) -> Result<(NodeId, Ipv4Addr, u64), CoordError> {
        match self {
            Store::Memory(m) => m.register_node_with(tenant_id, machine_key, info, reg),
            Store::Pg(p) => p.register_node_with(tenant_id, machine_key, info, reg).await,
            Store::Sqlite(s) => s.register_node_with(tenant_id, machine_key, info, reg).await,
        }
    }

    pub async fn set_advertised_routes(&self, node_id: NodeId, routes: Vec<String>) -> Result<bool, CoordError> {
        match self {
            Store::Memory(m) => m.set_advertised_routes(node_id, routes),
            Store::Pg(p) => p.set_advertised_routes(node_id, routes).await,
            Store::Sqlite(s) => s.set_advertised_routes(node_id, routes).await,
        }
    }

    pub async fn set_approved_routes(&self, node_id: NodeId, routes: Vec<String>) -> Result<bool, CoordError> {
        match self {
            Store::Memory(m) => m.set_approved_routes(node_id, routes),
            Store::Pg(p) => p.set_approved_routes(node_id, routes).await,
            Store::Sqlite(s) => s.set_approved_routes(node_id, routes).await,
        }
    }

    pub async fn delete_nodes_by_owner(&self, tenant_id: TenantId, owner: &str) -> Result<Vec<NodeId>, CoordError> {
        match self {
            Store::Memory(m) => m.delete_nodes_by_owner(tenant_id, owner),
            Store::Pg(p) => p.delete_nodes_by_owner(tenant_id, owner).await,
            Store::Sqlite(s) => s.delete_nodes_by_owner(tenant_id, owner).await,
        }
    }

    pub async fn delete_stale_ephemeral_nodes(&self, max_offline: chrono::Duration) -> Result<Vec<(TenantId, NodeId)>, CoordError> {
        match self {
            Store::Memory(m) => m.delete_stale_ephemeral_nodes(max_offline),
            Store::Pg(p) => p.delete_stale_ephemeral_nodes(max_offline).await,
            Store::Sqlite(s) => s.delete_stale_ephemeral_nodes(max_offline).await,
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
            Store::Sqlite(s) => s.register_node(tenant_id, machine_key, info).await,
        }
    }

    pub async fn rotate_node_key(
        &self,
        machine_key: &[u8; 32],
        old_node_key: &[u8; 32],
        new_node_key: &[u8; 32],
    ) -> Result<(), CoordError> {
        match self {
            Store::Memory(m) => m.rotate_node_key(machine_key, old_node_key, new_node_key),
            Store::Pg(p) => p.rotate_node_key(machine_key, old_node_key, new_node_key).await,
            Store::Sqlite(s) => s.rotate_node_key(machine_key, old_node_key, new_node_key).await,
        }
    }

    pub async fn update_endpoints(
        &self,
        node_id: NodeId,
        endpoints: Vec<String>,
        disco_key: Option<String>,
    ) -> Result<(), CoordError> {
        match self {
            Store::Memory(m) => m.update_endpoints(node_id, endpoints, disco_key),
            Store::Pg(p) => p.update_endpoints(node_id, endpoints, disco_key).await,
            Store::Sqlite(s) => s.update_endpoints(node_id, endpoints, disco_key).await,
        }
    }

    pub async fn get_node_by_machine_key(&self, machine_key: &[u8; 32]) -> Option<NodeId> {
        match self {
            Store::Memory(m) => m.get_node_by_machine_key(machine_key),
            Store::Pg(p) => p.get_node_by_machine_key(machine_key).await,
            Store::Sqlite(s) => s.get_node_by_machine_key(machine_key).await,
        }
    }

    /// The node currently registered with this node (WireGuard) public key.
    pub async fn get_node_by_node_key(&self, node_key: &[u8; 32]) -> Option<NodeId> {
        match self {
            Store::Memory(m) => m.get_node_by_node_key(node_key),
            Store::Pg(p) => p.get_node_by_node_key(node_key).await,
            Store::Sqlite(s) => s.get_node_by_node_key(node_key).await,
        }
    }

    pub async fn get_peers(&self, tenant_id: TenantId, exclude_node: NodeId) -> Vec<PeerInfo> {
        match self {
            Store::Memory(m) => m.get_peers(tenant_id, exclude_node),
            Store::Pg(p) => p.get_peers(tenant_id, exclude_node).await,
            Store::Sqlite(s) => s.get_peers(tenant_id, exclude_node).await,
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
            Store::Sqlite(s) => s.get_peers_with_children(tenant_id, exclude_node).await,
        }
    }

    pub async fn list_tenant_nodes(&self, tenant_id: TenantId) -> Vec<PeerInfo> {
        match self {
            Store::Memory(m) => m.list_tenant_nodes(tenant_id),
            Store::Pg(p) => p.list_tenant_nodes(tenant_id).await,
            Store::Sqlite(s) => s.list_tenant_nodes(tenant_id).await,
        }
    }

    pub async fn list_nodes_for_tenant(&self, tenant_id: TenantId) -> Vec<NodeSummary> {
        match self {
            Store::Memory(m) => m.list_nodes_for_tenant(tenant_id),
            Store::Pg(p) => p.list_nodes_for_tenant(tenant_id).await,
            Store::Sqlite(s) => s.list_nodes_for_tenant(tenant_id).await,
        }
    }

    pub async fn get_node_info(
        &self,
        node_id: NodeId,
    ) -> Option<NodeDetail> {
        match self {
            Store::Memory(m) => m.get_node_info(node_id),
            Store::Pg(p) => p.get_node_info(node_id).await,
            Store::Sqlite(s) => s.get_node_info(node_id).await,
        }
    }

    pub async fn get_node_ipv4(&self, node_id: NodeId) -> Option<Ipv4Addr> {
        match self {
            Store::Memory(m) => m.get_node_ipv4(node_id),
            Store::Pg(p) => p.get_node_ipv4(node_id).await,
            Store::Sqlite(s) => s.get_node_ipv4(node_id).await,
        }
    }

    pub async fn get_node_stable_id(&self, node_id: NodeId) -> Option<String> {
        match self {
            Store::Memory(m) => m.get_node_stable_id(node_id),
            Store::Pg(p) => p.get_node_stable_id(node_id).await,
            Store::Sqlite(s) => s.get_node_stable_id(node_id).await,
        }
    }

    pub async fn get_node_tenant(&self, node_id: NodeId) -> Option<TenantId> {
        match self {
            Store::Memory(m) => m.get_node_tenant(node_id),
            Store::Pg(p) => p.get_node_tenant(node_id).await,
            Store::Sqlite(s) => s.get_node_tenant(node_id).await,
        }
    }

    pub async fn list_nodes(&self) -> Vec<NodeSummary> {
        match self {
            Store::Memory(m) => m.list_nodes(),
            Store::Pg(p) => p.list_nodes().await,
            Store::Sqlite(s) => s.list_nodes().await,
        }
    }

    pub async fn delete_node(&self, node_id: NodeId) -> Result<TenantId, CoordError> {
        match self {
            Store::Memory(m) => m.delete_node(node_id),
            Store::Pg(p) => p.delete_node(node_id).await,
            Store::Sqlite(s) => s.delete_node(node_id).await,
        }
    }

    pub async fn rename_node(&self, node_id: NodeId, new_name: String) -> Result<(), CoordError> {
        match self {
            Store::Memory(m) => m.rename_node(node_id, new_name),
            Store::Pg(p) => p.rename_node(node_id, new_name).await,
            Store::Sqlite(s) => s.rename_node(node_id, new_name).await,
        }
    }

    pub async fn set_node_online(&self, node_id: NodeId, online: bool) -> Result<(), CoordError> {
        match self {
            Store::Memory(m) => m.set_node_online(node_id, online),
            Store::Pg(p) => p.set_node_online(node_id, online).await,
            Store::Sqlite(s) => s.set_node_online(node_id, online).await,
        }
    }

    pub async fn set_node_offline_if_current(&self, node_id: NodeId, generation: u64) -> Result<(), CoordError> {
        match self {
            Store::Memory(m) => m.set_node_offline_if_current(node_id, generation),
            Store::Pg(p) => p.set_node_offline_if_current(node_id, generation).await,
            Store::Sqlite(s) => s.set_node_offline_if_current(node_id, generation).await,
        }
    }

    pub async fn get_tenant_route_snapshot(
        &self,
        tenant_id: TenantId,
    ) -> Result<crate::memory::TenantRouteSnapshot, CoordError> {
        match self {
            Store::Memory(m) => m.get_tenant_route_snapshot(tenant_id),
            Store::Pg(p) => p.get_tenant_route_snapshot(tenant_id).await,
            Store::Sqlite(s) => s.get_tenant_route_snapshot(tenant_id).await,
        }
    }
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Store::Memory(m) => m.fmt(f),
            Store::Pg(p) => p.fmt(f),
            Store::Sqlite(s) => s.fmt(f),
        }
    }
}
