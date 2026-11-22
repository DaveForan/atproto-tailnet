use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::Mutex;
use tokio::sync::broadcast;

use coord_core::{
    CoordError, CreatedPreAuthKey, FederationPosture, NodeAttrs, NodeDetail, NodeId, NodeInfo,
    NodeRegistration, NodeSummary, PeerInfo, PreAuthGrant, PreAuthKeyInfo, PreAuthKeyOptions, Tenant,
    TenantId,
};
use coord_core::clock::{self, Duration, OffsetDateTime};

use crate::{generate_auth_key, generate_random_id};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
    last_seen: OffsetDateTime,
    attrs: NodeAttrs,
}

#[derive(Debug)]
struct PreAuthKey {
    id: uuid::Uuid,
    /// Non-secret start of the key; the map is keyed by the key's hash.
    prefix: String,
    tenant_id: TenantId,
    used: bool,
    reusable: bool,
    ephemeral: bool,
    owner: Option<String>,
    tags: Vec<String>,
    expires_at: Option<OffsetDateTime>,
    created_at: OffsetDateTime,
    revoked_at: Option<OffsetDateTime>,
}

pub struct MemoryStore {
    tenants: Mutex<HashMap<TenantId, Tenant>>,
    access: Mutex<HashMap<TenantId, coord_core::TenantAccess>>,
    dns: Mutex<HashMap<TenantId, coord_core::TenantDns>>,
    owner_locks: Mutex<HashMap<(TenantId, String), coord_core::OwnerLock>>,
    tenant_config: Mutex<HashMap<(TenantId, String), serde_json::Value>>,
    /// id -> (sign-in, expiry in unix seconds)
    sign_ins: Mutex<HashMap<String, (coord_core::PendingSignIn, i64)>>,
    remote_tx: broadcast::Sender<crate::RemoteEvent>,
    /// region id -> (relay, last seen in unix seconds)
    relays: Mutex<HashMap<i32, (coord_core::RelayInfo, i64)>>,
    home_relays: Mutex<HashMap<NodeId, i32>>,
    gateway_offers: Mutex<HashMap<TenantId, coord_core::GatewayOffer>>,
    nodes: Mutex<HashMap<NodeId, StoredNode>>,
    machine_key_index: Mutex<HashMap<[u8; 32], NodeId>>,
    preauth_keys: Mutex<HashMap<String, PreAuthKey>>,
    next_node_id: Mutex<i64>,
    peer_tx: broadcast::Sender<PeerEvent>,
}

/// (id, hostname) of the nodes of `tenant` other than `except`.
fn tenant_names(
    nodes: &HashMap<NodeId, StoredNode>,
    tenant: TenantId,
    except: NodeId,
) -> Vec<(i64, &str)> {
    nodes
        .values()
        .filter(|n| n.tenant_id == tenant && n.id != except)
        .map(|n| (n.id.as_i64(), n.info.hostname.as_str()))
        .collect()
}

impl MemoryStore {
    pub fn new() -> Self {
        let (peer_tx, _) = broadcast::channel(crate::PEER_EVENT_CHANNEL_CAPACITY);
        Self {
            tenants: Mutex::new(HashMap::new()),
            access: Mutex::new(HashMap::new()),
            dns: Mutex::new(HashMap::new()),
            owner_locks: Mutex::new(HashMap::new()),
            tenant_config: Mutex::new(HashMap::new()),
            sign_ins: Mutex::new(HashMap::new()),
            remote_tx: broadcast::channel(16).0,
            relays: Mutex::new(HashMap::new()),
            home_relays: Mutex::new(HashMap::new()),
            gateway_offers: Mutex::new(HashMap::new()),
            nodes: Mutex::new(HashMap::new()),
            machine_key_index: Mutex::new(HashMap::new()),
            preauth_keys: Mutex::new(HashMap::new()),
            next_node_id: Mutex::new(1),
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
        posture: Option<FederationPosture>,
    ) -> Result<Tenant, CoordError> {
        let mut tenants = self.tenants.lock().unwrap_or_else(|e| e.into_inner());
        if tenants.values().any(|t| t.slug == slug) {
            return Err(CoordError::Protocol(format!("tenant slug '{}' already exists", slug)));
        }
        if let Some(pid) = parent_id {
            crate::check_create_parent(pid, tenants.get(&pid).map(|p| p.parent_id.is_some()))?;
        }
        let tenant = Tenant {
            id: TenantId::generate(),
            slug,
            parent_id,
            federation_posture: posture.unwrap_or_default(),
            ipv4_prefix: coord_core::DEFAULT_IPV4_PREFIX.into(),
            ipv6_prefix: coord_core::DEFAULT_IPV6_PREFIX.into(),
            created_at: clock::now(),
            suspended: false,
        };
        tenants.insert(tenant.id, tenant.clone());
        Ok(tenant)
    }

    pub fn get_tenant(&self, tenant_id: TenantId) -> Option<Tenant> {
        let tenants = self.tenants.lock().unwrap_or_else(|e| e.into_inner());
        tenants.get(&tenant_id).cloned()
    }

    pub fn get_tenant_access(&self, tenant_id: TenantId) -> coord_core::TenantAccess {
        self.access.lock().unwrap_or_else(|e| e.into_inner()).get(&tenant_id).cloned().unwrap_or_default()
    }

    pub fn set_tenant_access(&self, tenant_id: TenantId, access: coord_core::TenantAccess) -> Result<(), CoordError> {
        if self.get_tenant(tenant_id).is_none() {
            return Err(CoordError::TenantNotFound(tenant_id));
        }
        self.access.lock().unwrap_or_else(|e| e.into_inner()).insert(tenant_id, access);
        Ok(())
    }

    pub fn get_tenant_dns(&self, tenant_id: TenantId) -> coord_core::TenantDns {
        self.dns.lock().unwrap_or_else(|e| e.into_inner()).get(&tenant_id).cloned().unwrap_or_default()
    }

    pub fn set_tenant_dns(&self, tenant_id: TenantId, dns: coord_core::TenantDns) -> Result<(), CoordError> {
        if self.get_tenant(tenant_id).is_none() {
            return Err(CoordError::TenantNotFound(tenant_id));
        }
        self.dns.lock().unwrap_or_else(|e| e.into_inner()).insert(tenant_id, dns);
        Ok(())
    }

    pub fn subscribe_remote(&self) -> broadcast::Receiver<crate::RemoteEvent> {
        self.remote_tx.subscribe()
    }

    pub fn get_tenant_configs(&self, tenant_id: TenantId) -> Result<Vec<(String, serde_json::Value)>, CoordError> {
        let cfg = self.tenant_config.lock().unwrap_or_else(|e| e.into_inner());
        Ok(cfg.iter().filter(|((t, _), _)| *t == tenant_id).map(|((_, k), v)| (k.clone(), v.clone())).collect())
    }

    pub fn list_tenant_configs(&self) -> Result<Vec<(TenantId, String, serde_json::Value)>, CoordError> {
        let cfg = self.tenant_config.lock().unwrap_or_else(|e| e.into_inner());
        Ok(cfg.iter().map(|((t, k), v)| (*t, k.clone(), v.clone())).collect())
    }

    pub fn set_tenant_config(&self, tenant_id: TenantId, kind: &str, value: Option<serde_json::Value>) -> Result<(), CoordError> {
        if self.get_tenant(tenant_id).is_none() {
            return Err(CoordError::TenantNotFound(tenant_id));
        }
        let mut cfg = self.tenant_config.lock().unwrap_or_else(|e| e.into_inner());
        match value {
            Some(v) => cfg.insert((tenant_id, kind.to_string()), v),
            None => cfg.remove(&(tenant_id, kind.to_string())),
        };
        Ok(())
    }

    pub fn sign_in_start(
        &self,
        id: &str,
        machine_key: &[u8; 32],
        hostname: &str,
        os: &str,
        requester_ip: Option<&str>,
        limits: coord_core::SignInLimits,
    ) -> Result<coord_core::SignInStart, CoordError> {
        let now = crate::now_secs();
        let mut all = self.sign_ins.lock().unwrap_or_else(|e| e.into_inner());
        all.retain(|_, (p, exp)| &p.machine_key != machine_key && *exp > now);
        if let Some(ip) = requester_ip {
            let from_ip = all.values().filter(|(p, _)| p.requester_ip.as_deref() == Some(ip)).count();
            if i64::try_from(from_ip).unwrap_or(i64::MAX) >= limits.per_ip {
                return Ok(coord_core::SignInStart::TooManyFromAddress);
            }
        }
        if i64::try_from(all.len()).unwrap_or(i64::MAX) >= limits.total {
            return Ok(coord_core::SignInStart::Full);
        }
        let p = coord_core::PendingSignIn {
            machine_key: *machine_key,
            hostname: hostname.to_string(),
            os: os.to_string(),
            decision: None,
            requester_ip: requester_ip.map(str::to_string),
            requested_at: clock::from_unix(now).unwrap_or(clock::EPOCH),
        };
        all.insert(id.to_string(), (p, now + coord_core::signin::SIGN_IN_TTL_SECS));
        Ok(coord_core::SignInStart::Started)
    }

    pub fn sign_in_get(&self, id: &str) -> Option<coord_core::PendingSignIn> {
        let all = self.sign_ins.lock().unwrap_or_else(|e| e.into_inner());
        all.get(id).filter(|(_, exp)| *exp > crate::now_secs()).map(|(p, _)| p.clone())
    }

    pub fn sign_in_decide(&self, id: &str, decision: &coord_core::SignInDecision) -> bool {
        let mut all = self.sign_ins.lock().unwrap_or_else(|e| e.into_inner());
        match all.get_mut(id) {
            Some((p, exp)) if *exp > crate::now_secs() && p.decision.is_none() => {
                p.decision = Some(decision.clone());
                true
            }
            _ => false,
        }
    }

    pub fn sign_in_take(&self, id: &str) -> Option<coord_core::SignInDecision> {
        let mut all = self.sign_ins.lock().unwrap_or_else(|e| e.into_inner());
        all.get(id)?.0.decision.as_ref()?;
        all.remove(id).and_then(|(p, _)| p.decision)
    }

    pub fn offer_gateway(&self, tenant_id: TenantId, offer: &coord_core::GatewayOffer) -> Result<(), CoordError> {
        if !self.tenants.lock().unwrap_or_else(|e| e.into_inner()).contains_key(&tenant_id) {
            return Err(CoordError::TenantNotFound(tenant_id));
        }
        let mut offer = offer.clone();
        offer.endpoints.truncate(coord_core::MAX_GATEWAY_ENDPOINTS);
        self.gateway_offers.lock().unwrap_or_else(|e| e.into_inner()).insert(tenant_id, offer);
        Ok(())
    }

    pub fn get_gateway_offer(&self, tenant_id: TenantId) -> Option<coord_core::GatewayOffer> {
        self.gateway_offers.lock().unwrap_or_else(|e| e.into_inner()).get(&tenant_id).cloned()
    }

    pub fn relay_heartbeat(&self, relay: &coord_core::RelayInfo) -> Result<(), CoordError> {
        let mut relays = self.relays.lock().unwrap_or_else(|e| e.into_inner());
        relays.insert(relay.region_id, (relay.clone(), crate::now_secs()));
        Ok(())
    }

    pub fn list_relays(&self, max_age_secs: i64) -> Vec<coord_core::RelayInfo> {
        let oldest = crate::now_secs() - max_age_secs;
        let relays = self.relays.lock().unwrap_or_else(|e| e.into_inner());
        relays.values().filter(|(_, seen)| *seen >= oldest).map(|(r, _)| r.clone()).collect()
    }

    pub fn set_home_relay(&self, node_id: NodeId, region: i32) -> Result<bool, CoordError> {
        let tenant_id = {
            let nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
            match nodes.get(&node_id) {
                Some(n) => n.tenant_id,
                None => return Ok(false),
            }
        };
        let changed = self.home_relays.lock().unwrap_or_else(|e| e.into_inner()).insert(node_id, region) != Some(region);
        if changed {
            let _ = self.peer_tx.send(PeerEvent::NodeUpdated { tenant_id, node_id });
        }
        Ok(changed)
    }

    pub fn home_relays(&self, node_ids: &[NodeId]) -> HashMap<NodeId, i32> {
        let all = self.home_relays.lock().unwrap_or_else(|e| e.into_inner());
        node_ids.iter().filter_map(|id| all.get(id).map(|r| (*id, *r))).collect()
    }

    pub fn list_owner_locks(&self) -> Vec<(TenantId, String, coord_core::OwnerLock)> {
        let locks = self.owner_locks.lock().unwrap_or_else(|e| e.into_inner());
        locks.iter().map(|((t, o), l)| (*t, o.clone(), l.clone())).collect()
    }

    pub fn get_owner_lock(&self, tenant_id: TenantId, owner: &str) -> coord_core::LockRead {
        match self.owner_locks.lock().unwrap_or_else(|e| e.into_inner()).get(&(tenant_id, owner.to_string())) {
            Some(l) => coord_core::LockRead::Locked(l.clone()),
            None => coord_core::LockRead::Unlocked,
        }
    }

    /// The map's mutex is held across `f`, so updates cannot interleave.
    pub fn update_owner_lock<R, F>(&self, tenant_id: TenantId, owner: &str, f: F) -> Result<R, CoordError>
    where
        F: FnOnce(coord_core::LockRead) -> (coord_core::LockWrite, R),
    {
        if self.get_tenant(tenant_id).is_none() {
            return Err(CoordError::TenantNotFound(tenant_id));
        }
        let mut locks = self.owner_locks.lock().unwrap_or_else(|e| e.into_inner());
        let key = (tenant_id, owner.to_string());
        let read = match locks.get(&key) {
            Some(l) => coord_core::LockRead::Locked(l.clone()),
            None => coord_core::LockRead::Unlocked,
        };
        let (write, out) = f(read);
        match write {
            coord_core::LockWrite::Keep => {}
            coord_core::LockWrite::Set(l) => {
                locks.insert(key, l);
            }
            coord_core::LockWrite::Remove => {
                locks.remove(&key);
            }
        }
        Ok(out)
    }

    pub fn list_tenants(&self) -> Vec<Tenant> {
        let tenants = self.tenants.lock().unwrap_or_else(|e| e.into_inner());
        tenants.values().cloned().collect()
    }

    pub fn delete_tenant(&self, tenant_id: TenantId) -> Result<(), CoordError> {
        // Hold the tenants lock throughout, so no node is orphaned (TOCTOU).
        // Lock ordering: tenants → machine_key_index → nodes → preauth_keys
        let mut tenants = self.tenants.lock().unwrap_or_else(|e| e.into_inner());

        let has_children = tenants.values().any(|t| t.parent_id == Some(tenant_id));
        if has_children {
            return Err(CoordError::Protocol(
                "cannot delete tenant with children".into(),
            ));
        }

        if tenants.remove(&tenant_id).is_none() {
            return Err(CoordError::TenantNotFound(tenant_id));
        }

        // Remove the tenant's nodes in the same lock scope.
        let mut machine_index = self.machine_key_index.lock().unwrap_or_else(|e| e.into_inner());
        let mut nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());

        let removed_node_ids: Vec<(NodeId, [u8; 32])> = nodes
            .iter()
            .filter(|(_, n)| n.tenant_id == tenant_id)
            .map(|(nid, _)| {
                let nid = *nid;
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

        self.owner_locks.lock().unwrap_or_else(|e| e.into_inner()).retain(|(t, _), _| *t != tenant_id);
        self.tenant_config.lock().unwrap_or_else(|e| e.into_inner()).retain(|(t, _), _| *t != tenant_id);
        self.gateway_offers.lock().unwrap_or_else(|e| e.into_inner()).remove(&tenant_id);

        let mut keys = self.preauth_keys.lock().unwrap_or_else(|e| e.into_inner());
        keys.retain(|_, v| v.tenant_id != tenant_id);

        // Release all locks before broadcasting.
        drop(keys);
        drop(nodes);
        drop(machine_index);
        drop(tenants);

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

    /// Set or clear the parent of a tenant. Returns the tenant and its previous parent.
    pub fn set_tenant_parent(
        &self,
        tenant_id: TenantId,
        parent_id: Option<TenantId>,
    ) -> Result<(Tenant, Option<TenantId>), CoordError> {
        let mut tenants = self.tenants.lock().unwrap_or_else(|e| e.into_inner());
        if !tenants.contains_key(&tenant_id) {
            return Err(CoordError::TenantNotFound(tenant_id));
        }
        if let Some(pid) = parent_id {
            let has_children = tenants.values().any(|t| t.parent_id == Some(tenant_id));
            crate::check_new_parent(tenant_id, pid, tenants.get(&pid), has_children)?;
        }
        let t = tenants.get_mut(&tenant_id).ok_or(CoordError::TenantNotFound(tenant_id))?;
        let old = std::mem::replace(&mut t.parent_id, parent_id);
        Ok((t.clone(), old))
    }

    pub fn set_tenant_suspended(
        &self,
        tenant_id: TenantId,
        suspended: bool,
    ) -> Result<Tenant, CoordError> {
        let mut tenants = self.tenants.lock().unwrap_or_else(|e| e.into_inner());
        match tenants.get_mut(&tenant_id) {
            Some(t) => {
                t.suspended = suspended;
                Ok(t.clone())
            }
            None => Err(CoordError::TenantNotFound(tenant_id)),
        }
    }

    pub fn create_preauth_key(&self, tenant_id: TenantId, reusable: bool) -> Result<String, CoordError> {
        self.create_preauth_key_with(tenant_id, PreAuthKeyOptions { reusable, ..Default::default() })
            .map(|k| k.key)
    }

    pub fn create_preauth_key_with(
        &self,
        tenant_id: TenantId,
        opts: PreAuthKeyOptions,
    ) -> Result<CreatedPreAuthKey, CoordError> {
        let tenants = self.tenants.lock().unwrap_or_else(|e| e.into_inner());
        if !tenants.contains_key(&tenant_id) {
            return Err(CoordError::TenantNotFound(tenant_id));
        }
        drop(tenants);

        let key = generate_auth_key();
        let id = uuid::Uuid::new_v4();
        let mut keys = self.preauth_keys.lock().unwrap_or_else(|e| e.into_inner());
        keys.insert(
            crate::hash_preauth_key(&key),
            PreAuthKey {
                id,
                prefix: coord_core::preauth_key_prefix(&key),
                tenant_id,
                used: false,
                reusable: opts.reusable,
                ephemeral: opts.ephemeral,
                owner: opts.owner,
                tags: opts.tags,
                expires_at: opts.expires_at,
                created_at: clock::now(),
                revoked_at: None,
            },
        );
        Ok(CreatedPreAuthKey { id, key, tenant_id, expires_at: opts.expires_at })
    }

    pub fn list_preauth_keys(&self, tenant_id: TenantId) -> Vec<PreAuthKeyInfo> {
        let keys = self.preauth_keys.lock().unwrap_or_else(|e| e.into_inner());
        let mut out: Vec<PreAuthKeyInfo> = keys
            .values()
            .filter(|k| k.tenant_id == tenant_id)
            .map(|k| PreAuthKeyInfo {
                id: k.id,
                tenant_id: k.tenant_id,
                prefix: k.prefix.clone(),
                owner: k.owner.clone(),
                tags: k.tags.clone(),
                reusable: k.reusable,
                ephemeral: k.ephemeral,
                used: k.used,
                expires_at: k.expires_at,
                created_at: k.created_at,
                revoked: k.revoked_at.is_some(),
            })
            .collect();
        out.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
        out
    }

    /// Revoke one key. `Ok(false)` if no such key in this tenant.
    pub fn revoke_preauth_key(&self, tenant_id: TenantId, key_id: uuid::Uuid) -> Result<bool, CoordError> {
        let mut keys = self.preauth_keys.lock().unwrap_or_else(|e| e.into_inner());
        match keys.values_mut().find(|k| k.tenant_id == tenant_id && k.id == key_id) {
            Some(k) => {
                if k.revoked_at.is_none() {
                    k.revoked_at = Some(clock::now());
                }
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// Revoke every not-yet-revoked key of `owner` in this tenant; returns the count.
    pub fn revoke_preauth_keys_by_owner(&self, tenant_id: TenantId, owner: &str) -> Result<u64, CoordError> {
        let mut keys = self.preauth_keys.lock().unwrap_or_else(|e| e.into_inner());
        let now = clock::now();
        let mut n = 0;
        for k in keys.values_mut() {
            if k.tenant_id == tenant_id && k.owner.as_deref() == Some(owner) && k.revoked_at.is_none() {
                k.revoked_at = Some(now);
                n += 1;
            }
        }
        Ok(n)
    }

    /// Tenant a pre-auth key belongs to, without validating or consuming it.
    pub fn preauth_key_tenant(&self, key: &str) -> Option<TenantId> {
        let keys = self.preauth_keys.lock().unwrap_or_else(|e| e.into_inner());
        keys.get(&crate::hash_preauth_key(key)).map(|k| k.tenant_id)
    }

    pub fn validate_preauth_key(&self, key: &str) -> Option<PreAuthGrant> {
        let mut keys = self.preauth_keys.lock().unwrap_or_else(|e| e.into_inner());
        let pak = keys.get_mut(&crate::hash_preauth_key(key))?;

        if pak.revoked_at.is_some() {
            return None;
        }
        if pak.used && !pak.reusable {
            return None;
        }
        if let Some(expires) = pak.expires_at
            && clock::now() >= expires {
                return None;
            }

        pak.used = true;
        Some(PreAuthGrant {
            tenant_id: pak.tenant_id,
            owner: pak.owner.clone(),
            tags: pak.tags.clone(),
            ephemeral: pak.ephemeral,
        })
    }

    pub fn register_node(
        &self,
        tenant_id: TenantId,
        machine_key: [u8; 32],
        info: NodeInfo,
    ) -> Result<(NodeId, Ipv4Addr, u64), CoordError> {
        self.register_node_with(tenant_id, machine_key, info, NodeRegistration::default())
    }

    pub fn register_node_with(
        &self,
        tenant_id: TenantId,
        machine_key: [u8; 32],
        info: NodeInfo,
        reg: NodeRegistration,
    ) -> Result<(NodeId, Ipv4Addr, u64), CoordError> {
        let mut machine_index = self.machine_key_index.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(&existing_id) = machine_index.get(&machine_key) {
            let mut nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(node) = nodes.get(&existing_id) {
                if node.tenant_id != tenant_id {
                    return Err(CoordError::Protocol(
                        "machine key already registered to a different tenant".into(),
                    ));
                }
                let mut info = info;
                info.hostname = crate::unique_hostname(
                    &info.hostname,
                    coord_core::is_gateway_identity(reg.owner.as_deref(), &reg.tags),
                    tenant_names(&nodes, tenant_id, existing_id),
                );
                let Some(node) = nodes.get_mut(&existing_id) else { unreachable!("checked above") };
                node.info = info;
                node.online = true;
                node.last_seen = clock::now();
                node.session_generation += 1;
                if node.attrs.owner != reg.owner || node.attrs.tags != reg.tags {
                    // A new identity must not inherit approvals granted to the old one.
                    node.attrs.approved_routes.clear();
                }
                node.attrs.owner = reg.owner;
                node.attrs.tags = reg.tags;
                node.attrs.ephemeral = reg.ephemeral;
                if let Some(routes) = reg.advertised_routes {
                    node.attrs.advertised_routes = routes;
                }
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

        // machine_key_index is held, so allocations are serialized.
        let mut nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
        let ipv4 = crate::lowest_free_ipv4(nodes.values().map(|n| n.ipv4))?;

        let node_id = {
            let mut id = self.next_node_id.lock().unwrap_or_else(|e| e.into_inner());
            let current = *id;
            *id = current.checked_add(1).ok_or_else(|| {
                CoordError::Protocol("node ID space exhausted".into())
            })?;
            NodeId::new(current)
        };

        let stable_id = generate_random_id();
        let mut info = info;
        info.hostname = crate::unique_hostname(
            &info.hostname,
            coord_core::is_gateway_identity(reg.owner.as_deref(), &reg.tags),
            tenant_names(&nodes, tenant_id, node_id),
        );

        let stored = StoredNode {
            id: node_id,
            tenant_id,
            info,
            ipv4,
            stable_id,
            online: true,
            session_generation: 1,
            last_seen: clock::now(),
            attrs: NodeAttrs {
                owner: reg.owner,
                tags: reg.tags,
                ephemeral: reg.ephemeral,
                advertised_routes: reg.advertised_routes.unwrap_or_default(),
                approved_routes: vec![],
            },
        };

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
    ) -> Result<(), CoordError> {
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
        Ok(())
    }

    pub fn update_endpoints(
        &self,
        node_id: NodeId,
        endpoints: Vec<String>,
        disco_key: Option<String>,
    ) -> Result<(), CoordError> {
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
        Ok(())
    }

    pub fn get_node_by_machine_key(&self, machine_key: &[u8; 32]) -> Option<NodeId> {
        let index = self.machine_key_index.lock().unwrap_or_else(|e| e.into_inner());
        index.get(machine_key).copied()
    }

    pub fn get_node_by_node_key(&self, node_key: &[u8; 32]) -> Option<NodeId> {
        let nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
        nodes.values().find(|n| n.info.node_key.as_slice() == node_key).map(|n| n.id)
    }

    pub fn get_peers(&self, tenant_id: TenantId, exclude_node: NodeId) -> Vec<PeerInfo> {
        let nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
        nodes
            .values()
            .filter(|n| n.tenant_id == tenant_id && n.id != exclude_node)
            .map(stored_node_to_peer_info)
            .collect()
    }

    pub fn get_peers_with_children(
        &self,
        tenant_id: TenantId,
        exclude_node: NodeId,
    ) -> Vec<PeerInfo> {
        // Hold both locks, so a posture change cannot race this read (TOCTOU).
        // Lock ordering: always tenants before nodes.
        let tenants = self.tenants.lock().unwrap_or_else(|e| e.into_inner());
        let nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());

        let child_ids: Vec<TenantId> = tenants
            .values()
            .filter(|t| {
                t.parent_id == Some(tenant_id) && t.visible_to_parent()
            })
            .map(|t| t.id)
            .collect();

        let result = nodes
            .values()
            .filter(|n| {
                n.id != exclude_node
                    && (n.tenant_id == tenant_id || child_ids.contains(&n.tenant_id))
            })
            .map(stored_node_to_peer_info)
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
            .map(stored_node_to_peer_info)
            .collect()
    }

    pub fn list_nodes_for_tenant(&self, tenant_id: TenantId) -> Vec<NodeSummary> {
        let nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
        nodes
            .values()
            .filter(|n| n.tenant_id == tenant_id)
            .map(stored_node_to_summary)
            .collect()
    }

    pub fn get_node_info(&self, node_id: NodeId) -> Option<NodeDetail> {
        let nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
        nodes.get(&node_id).map(|n| NodeDetail {
            tenant_id: n.tenant_id,
            ipv4: n.ipv4,
            stable_id: n.stable_id.clone(),
            info: n.info.clone(),
            online: n.online,
            attrs: n.attrs.clone(),
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

    pub fn list_nodes(&self) -> Vec<NodeSummary> {
        let nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
        nodes
            .values()
            .map(stored_node_to_summary)
            .collect()
    }

    pub fn delete_node(&self, node_id: NodeId) -> Result<TenantId, CoordError> {
        // Lock ordering: machine_key_index before nodes (matches register_node).
        let mut machine_index = self.machine_key_index.lock().unwrap_or_else(|e| e.into_inner());
        let mut nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
        let node = nodes.remove(&node_id)
            .ok_or(CoordError::Protocol("node not found".into()))?;
        let tid = node.tenant_id;

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
        let node = nodes.get(&node_id)
            .ok_or(CoordError::Protocol("node not found".into()))?;
        let tid = node.tenant_id;
        let is_gateway = coord_core::is_gateway_identity(node.attrs.owner.as_deref(), &node.attrs.tags);
        let name = crate::unique_hostname(&new_name, is_gateway, tenant_names(&nodes, tid, node_id));
        if let Some(node) = nodes.get_mut(&node_id) {
            node.info.hostname = name;
        }
        drop(nodes);
        let _ = self.peer_tx.send(PeerEvent::NodeUpdated { tenant_id: tid, node_id });
        Ok(())
    }

    pub fn set_node_online(&self, node_id: NodeId, online: bool) -> Result<(), CoordError> {
        let mut nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(node) = nodes.get_mut(&node_id) {
            node.online = online;
            node.last_seen = clock::now();
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
        Ok(())
    }

    pub fn set_node_offline_if_current(&self, node_id: NodeId, generation: u64) -> Result<(), CoordError> {
        let mut nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(node) = nodes.get_mut(&node_id) {
            if node.session_generation != generation {
                return Ok(());
            }
            node.online = false;
            node.last_seen = clock::now();
            let tid = node.tenant_id;
            drop(nodes);
            let _ = self.peer_tx.send(PeerEvent::NodeOffline {
                tenant_id: tid,
                node_id,
            });
        }
        Ok(())
    }

    /// Starts a map session of a known node: online, new generation. Returns the generation.
    pub fn begin_node_session(&self, node_id: NodeId) -> Result<u64, CoordError> {
        let mut nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
        let Some(node) = nodes.get_mut(&node_id) else {
            return Err(CoordError::Protocol(format!("node {node_id} not found")));
        };
        node.online = true;
        node.last_seen = clock::now();
        node.session_generation += 1;
        let generation = node.session_generation;
        let tid = node.tenant_id;
        drop(nodes);
        let _ = self.peer_tx.send(PeerEvent::NodeUpdated {
            tenant_id: tid,
            node_id,
        });
        Ok(generation)
    }

    /// Replace a node's advertised routes. Returns true if they changed.
    pub fn set_advertised_routes(&self, node_id: NodeId, routes: Vec<String>) -> Result<bool, CoordError> {
        self.update_attrs(node_id, |a| {
            if a.advertised_routes == routes {
                return false;
            }
            a.advertised_routes = routes;
            true
        })
    }

    /// Replace a node's approved routes. Returns true if they changed.
    pub fn set_approved_routes(&self, node_id: NodeId, routes: Vec<String>) -> Result<bool, CoordError> {
        self.update_attrs(node_id, |a| {
            if a.approved_routes == routes {
                return false;
            }
            a.approved_routes = routes;
            true
        })
    }

    fn update_attrs(
        &self,
        node_id: NodeId,
        f: impl FnOnce(&mut NodeAttrs) -> bool,
    ) -> Result<bool, CoordError> {
        let mut nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
        let node = nodes
            .get_mut(&node_id)
            .ok_or(CoordError::Protocol("node not found".into()))?;
        let changed = f(&mut node.attrs);
        let tid = node.tenant_id;
        drop(nodes);
        if changed {
            let _ = self.peer_tx.send(PeerEvent::NodeUpdated { tenant_id: tid, node_id });
        }
        Ok(changed)
    }

    /// Delete every node in `tenant_id` owned by `owner`; returns the deleted IDs.
    pub fn delete_nodes_by_owner(&self, tenant_id: TenantId, owner: &str) -> Result<Vec<NodeId>, CoordError> {
        let removed = self.remove_nodes_where(|n| {
            n.tenant_id == tenant_id && n.attrs.owner.as_deref() == Some(owner)
        });
        Ok(removed.into_iter().map(|(_, nid)| nid).collect())
    }

    /// Delete ephemeral nodes that have been offline for at least `max_offline`.
    pub fn delete_stale_ephemeral_nodes(
        &self,
        max_offline: Duration,
    ) -> Result<Vec<(TenantId, NodeId)>, CoordError> {
        let cutoff = clock::now() - max_offline;
        Ok(self.remove_nodes_where(|n| n.attrs.ephemeral && !n.online && n.last_seen <= cutoff))
    }

    fn remove_nodes_where(&self, pred: impl Fn(&StoredNode) -> bool) -> Vec<(TenantId, NodeId)> {
        // Lock ordering: machine_key_index before nodes (matches register_node).
        let mut machine_index = self.machine_key_index.lock().unwrap_or_else(|e| e.into_inner());
        let mut nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
        let ids: Vec<NodeId> = nodes.values().filter(|n| pred(n)).map(|n| n.id).collect();
        let mut removed = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(node) = nodes.remove(&id) {
                if let Ok(key) = <[u8; 32]>::try_from(node.info.machine_key.as_slice()) {
                    machine_index.remove(&key);
                }
                removed.push((node.tenant_id, id));
            }
        }
        drop(nodes);
        drop(machine_index);
        removed.sort_by_key(|(_, id)| id.as_i64());
        for (tenant_id, node_id) in &removed {
            let _ = self.peer_tx.send(PeerEvent::NodeOffline { tenant_id: *tenant_id, node_id: *node_id });
        }
        removed
    }

    /// Atomically snapshots a tenant's routes: own nodes, children and visible child nodes.
    /// One lock scope stops posture and node changes from interleaving.
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
            .filter(|c| c.visible_to_parent())
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

fn stored_node_to_summary(n: &StoredNode) -> NodeSummary {
    NodeSummary {
        id: n.id,
        tenant_id: n.tenant_id,
        ipv4: n.ipv4,
        stable_id: n.stable_id.clone(),
        online: n.online,
        hostname: n.info.hostname.clone(),
        attrs: n.attrs.clone(),
    }
}

fn stored_node_to_peer_info(n: &StoredNode) -> PeerInfo {
    let (addresses, allowed_ips, primary_routes) = coord_core::node_route_sets(
        &n.ipv4.to_string(),
        &n.attrs.advertised_routes,
        &n.attrs.approved_routes,
    );
    PeerInfo {
        node_id: n.id,
        node_key: n.info.node_key.clone(),
        machine_key: n.info.machine_key.clone(),
        disco_key: n.info.disco_key.clone(),
        endpoints: n.info.endpoints.clone(),
        addresses,
        allowed_ips,
        primary_routes,
        hostname: n.info.hostname.clone(),
        derp_region: Some(1),
        online: n.online,
        last_seen: Some(n.last_seen),
        owner: n.attrs.owner.clone(),
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
        let t = store.create_tenant("single-use".into(), None, None).unwrap();
        let key = store.create_preauth_key(t.id, false).unwrap();

        assert_eq!(store.validate_preauth_key(&key).map(|g| g.tenant_id), Some(t.id));
        assert_eq!(store.validate_preauth_key(&key), None);
    }

    #[test]
    fn preauth_key_reusable() {
        let store = MemoryStore::new();
        let t = store.create_tenant("reusable".into(), None, None).unwrap();
        let key = store.create_preauth_key(t.id, true).unwrap();

        assert_eq!(store.validate_preauth_key(&key).map(|g| g.tenant_id), Some(t.id));
        assert_eq!(store.validate_preauth_key(&key).map(|g| g.tenant_id), Some(t.id));
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

        store.register_node(t1, mkey, info.clone()).unwrap();

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

        store.set_node_online(node_id, false).unwrap();
        let event = rx.try_recv().unwrap();
        match event {
            PeerEvent::NodeOffline { node_id: nid, .. } => {
                assert_eq!(nid, node_id);
            }
            _ => panic!("expected NodeOffline"),
        }
    }
}
