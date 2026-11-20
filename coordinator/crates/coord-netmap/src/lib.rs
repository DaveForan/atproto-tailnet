use std::sync::Arc;

use coord_acl::AclEngine;
use coord_acl::PolicyEngine;
use std::collections::HashMap;
use std::sync::RwLock;

use coord_core::keys::{format_machine_key, format_node_key};
use coord_core::routes::Cidr;
use coord_core::{MachineKey, TenantId};
use coord_proto::map::{DerpMap, DerpRegion, DnsConfig, MapNode, MapResponse, UserProfile};
use coord_store::{PeerEvent, Store};

#[derive(Debug, Clone)]
pub struct TenantDerp {
    pub custom_regions: HashMap<i32, DerpRegion>,
    pub include_default: bool,
}

/// Operator-wide default DERP map plus per-tenant overrides.
pub struct DerpRegistry {
    default: DerpMap,
    tenants: RwLock<HashMap<TenantId, TenantDerp>>,
}

impl DerpRegistry {
    pub fn new(default: DerpMap) -> Self {
        Self { default, tenants: RwLock::new(HashMap::new()) }
    }

    pub fn default_map(&self) -> &DerpMap {
        &self.default
    }

    pub fn set_tenant(&self, tenant: TenantId, cfg: TenantDerp) {
        self.tenants.write().unwrap_or_else(|e| e.into_inner()).insert(tenant, cfg);
    }

    pub fn get_tenant(&self, tenant: TenantId) -> Option<TenantDerp> {
        self.tenants.read().unwrap_or_else(|e| e.into_inner()).get(&tenant).cloned()
    }

    pub fn remove_tenant(&self, tenant: TenantId) {
        self.tenants.write().unwrap_or_else(|e| e.into_inner()).remove(&tenant);
    }

    pub fn map_for(&self, tenant: TenantId) -> DerpMap {
        let Some(cfg) = self.get_tenant(tenant) else {
            return self.default.clone();
        };
        let mut regions = if cfg.include_default {
            self.default.regions.clone()
        } else {
            HashMap::new()
        };
        regions.extend(cfg.custom_regions);
        DerpMap { regions, omit_default_regions: Some(true) }
    }
}

/// Per-tenant route auto-approval policy (in-memory; the TS service replays it).
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AutoApprovers {
    /// CIDR -> tags whose nodes get advertised routes inside that CIDR approved.
    #[serde(default)]
    pub routes: std::collections::BTreeMap<String, Vec<String>>,
    /// Tags whose nodes get exit routes (0.0.0.0/0, ::/0) approved.
    #[serde(default)]
    pub exit_node: Vec<String>,
}

impl AutoApprovers {
    /// The subset of `advertised` that a node carrying `tags` gets approved automatically.
    /// Untagged nodes never match. Exit routes are only approved via `exit_node`.
    pub fn approvable(&self, tags: &[String], advertised: &[String]) -> Vec<String> {
        if tags.is_empty() {
            return vec![];
        }
        let has_tag = |allowed: &[String]| allowed.iter().any(|t| tags.contains(t));
        let rules: Vec<(Cidr, &Vec<String>)> = self
            .routes
            .iter()
            .filter_map(|(cidr, tags)| Some((Cidr::parse(cidr)?, tags)))
            .collect();
        advertised
            .iter()
            .filter(|r| {
                let Some(route) = Cidr::parse(r) else { return false };
                if route.is_exit() {
                    return has_tag(&self.exit_node);
                }
                rules.iter().any(|(outer, allowed)| outer.contains(&route) && has_tag(allowed))
            })
            .cloned()
            .collect()
    }
}

#[derive(Default)]
pub struct AutoApproverRegistry {
    tenants: RwLock<HashMap<TenantId, AutoApprovers>>,
}

impl AutoApproverRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_tenant(&self, tenant: TenantId, cfg: AutoApprovers) {
        self.tenants.write().unwrap_or_else(|e| e.into_inner()).insert(tenant, cfg);
    }

    pub fn get_tenant(&self, tenant: TenantId) -> AutoApprovers {
        self.tenants
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(&tenant)
            .cloned()
            .unwrap_or_default()
    }

    pub fn remove_tenant(&self, tenant: TenantId) {
        self.tenants.write().unwrap_or_else(|e| e.into_inner()).remove(&tenant);
    }
}

/// Fallback names when the TS service has not pushed identity for a tenant/owner.
pub const DEFAULT_DOMAIN: &str = "mesh.local";
pub const DEFAULT_LOGIN_NAME: &str = "mesh@coordinator.local";
pub const DEFAULT_DISPLAY_NAME: &str = "Mesh User";

/// Upper bounds on pushed identity (in-memory, admin-only input).
pub const MAX_IDENTITY_USERS: usize = 10_000;
pub const MAX_IDENTITY_TEXT: usize = 256;

/// How one owner (the TS service's user id) is shown to Tailscale clients.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct UserIdentity {
    /// e.g. the Bluesky handle `alice.bsky.social`.
    pub login_name: String,
    #[serde(default)]
    pub display_name: String,
}

/// Per-tenant names shown in Tailscale clients (in-memory; the TS service
/// pushes and replays it). `tailnet_name` becomes the netmap `Domain`, which
/// clients show as the tailnet / profile name.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TenantIdentity {
    #[serde(default)]
    pub tailnet_name: Option<String>,
    /// owner id -> identity
    #[serde(default)]
    pub users: std::collections::BTreeMap<String, UserIdentity>,
}

impl TenantIdentity {
    /// Rejects oversized input and strips control characters from names.
    pub fn sanitized(mut self) -> Result<Self, &'static str> {
        if self.users.len() > MAX_IDENTITY_USERS {
            return Err("too many users");
        }
        fn clean(s: &str) -> Result<String, &'static str> {
            if s.len() > MAX_IDENTITY_TEXT {
                return Err("name too long");
            }
            Ok(s.chars().filter(|c| !c.is_control()).collect::<String>().trim().to_string())
        }
        self.tailnet_name = match self.tailnet_name {
            Some(n) => Some(clean(&n)?).filter(|n| !n.is_empty()),
            None => None,
        };
        let mut users = std::collections::BTreeMap::new();
        for (owner, u) in self.users {
            if owner.is_empty() || owner.len() > MAX_IDENTITY_TEXT {
                return Err("invalid owner id");
            }
            let login_name = clean(&u.login_name)?;
            if login_name.is_empty() {
                return Err("login_name is required");
            }
            let display_name = clean(&u.display_name)?;
            users.insert(owner, UserIdentity { login_name, display_name });
        }
        self.users = users;
        Ok(self)
    }
}

/// Stable Tailscale user id for an owner. Unowned nodes share id 1 (the
/// legacy single user); owners hash to a positive id that never collides with 1.
pub fn user_id_for(owner: Option<&str>) -> i64 {
    let Some(owner) = owner else { return 1 };
    // FNV-1a 64, kept within JSON-safe integer range (53 bits).
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in owner.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    let id = (h & 0x001f_ffff_ffff_ffff) as i64;
    if id <= 1 { id + 2 } else { id }
}

#[derive(Default)]
pub struct IdentityRegistry {
    tenants: RwLock<HashMap<TenantId, TenantIdentity>>,
}

impl IdentityRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_tenant(&self, tenant: TenantId, cfg: TenantIdentity) {
        self.tenants.write().unwrap_or_else(|e| e.into_inner()).insert(tenant, cfg);
    }

    pub fn get_tenant(&self, tenant: TenantId) -> TenantIdentity {
        self.tenants
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(&tenant)
            .cloned()
            .unwrap_or_default()
    }

    pub fn remove_tenant(&self, tenant: TenantId) {
        self.tenants.write().unwrap_or_else(|e| e.into_inner()).remove(&tenant);
    }

    /// The netmap Domain (tailnet name) for a tenant.
    pub fn domain(&self, tenant: TenantId) -> String {
        self.get_tenant(tenant).tailnet_name.unwrap_or_else(|| DEFAULT_DOMAIN.to_string())
    }

    /// The Tailscale user profile for an owner of a tenant.
    pub fn profile(&self, tenant: TenantId, owner: Option<&str>) -> UserProfile {
        let id = user_id_for(owner);
        let known = owner.and_then(|o| self.get_tenant(tenant).users.get(o).cloned());
        match known {
            Some(u) => UserProfile {
                id,
                display_name: if u.display_name.is_empty() { u.login_name.clone() } else { u.display_name },
                login_name: u.login_name,
            },
            None => UserProfile {
                id,
                login_name: DEFAULT_LOGIN_NAME.into(),
                display_name: DEFAULT_DISPLAY_NAME.into(),
            },
        }
    }
}

pub struct NetmapService {
    store: Arc<Store>,
    acl: Arc<PolicyEngine>,
    derp: Arc<DerpRegistry>,
    identity: Arc<IdentityRegistry>,
}

impl NetmapService {
    pub fn new(store: Arc<Store>, acl: Arc<PolicyEngine>, derp: Arc<DerpRegistry>) -> Self {
        Self::with_identity(store, acl, derp, Arc::new(IdentityRegistry::new()))
    }

    pub fn with_identity(
        store: Arc<Store>,
        acl: Arc<PolicyEngine>,
        derp: Arc<DerpRegistry>,
        identity: Arc<IdentityRegistry>,
    ) -> Self {
        Self { store, acl, derp, identity }
    }

    /// One profile per distinct owner (self first), for MapResponse.UserProfiles.
    fn profiles_for<'a>(
        &self,
        tenant: TenantId,
        owners: impl IntoIterator<Item = Option<&'a str>>,
    ) -> Vec<UserProfile> {
        let mut seen = std::collections::HashSet::new();
        owners
            .into_iter()
            .filter(|o| seen.insert(user_id_for(*o)))
            .map(|o| self.identity.profile(tenant, o))
            .collect()
    }

    pub async fn build_snapshot(
        &self,
        machine_key: &[u8; 32],
    ) -> Result<MapResponse, Box<dyn std::error::Error + Send + Sync>> {
        let node_id = self
            .store
            .get_node_by_machine_key(machine_key)
            .await
            .ok_or("node not registered")?;

        let detail = self
            .store
            .get_node_info(node_id)
            .await
            .ok_or("node info not found")?;

        let tenant_id = detail.tenant_id;
        let ipv4 = detail.ipv4;
        let (self_addresses, self_allowed, self_primary) = coord_core::node_route_sets(
            &ipv4.to_string(),
            &detail.attrs.advertised_routes,
            &detail.attrs.approved_routes,
        );

        let node_key_str = format_key_bytes(&detail.info.node_key);

        let children = self.store.get_child_tenants(tenant_id).await;
        let peers = if children.is_empty() {
            self.store.get_peers(tenant_id, node_id).await
        } else {
            self.store.get_peers_with_children(tenant_id, node_id).await
        };
        let derp_map = self.derp.map_for(tenant_id);
        let home_region = derp_map.regions.keys().min().copied().unwrap_or(1);
        let peer_nodes: Vec<MapNode> = peers
            .iter()
            .map(|p| peer_info_to_map_node(p, home_region))
            .collect();
        let self_owner = detail.attrs.owner.as_deref();
        let user_profiles = self.profiles_for(
            tenant_id,
            std::iter::once(self_owner).chain(peers.iter().map(|p| p.owner.as_deref())),
        );
        let domain = self.identity.domain(tenant_id);

        let self_node = MapNode {
            id: node_id.as_i64(),
            stable_id: detail.stable_id,
            name: format!("{}.mesh.local.", node_label(&detail.info.hostname, node_id.as_i64())),
            user: user_id_for(self_owner),
            key: node_key_str,
            machine: format_machine_key(&MachineKey(*machine_key)),
            disco_key: None,
            addresses: self_addresses,
            allowed_ips: self_allowed,
            primary_routes: self_primary,
            endpoints: vec![],
            derp: Some(format!("127.3.3.40:{}", home_region)),
            home_derp: Some(home_region),
            hostinfo: minimal_hostinfo(&node_label(&detail.info.hostname, node_id.as_i64())),
            online: Some(true),
            last_seen: None,
            machine_authorized: Some(true),
            key_expiry: None,
        };

        Ok(MapResponse {
            node: Some(self_node),
            peers: if peer_nodes.is_empty() {
                None
            } else {
                Some(peer_nodes)
            },
            peers_changed: None,
            peers_removed: None,
            derp_map: Some(derp_map),
            dns_config: Some(DnsConfig {
                resolvers: Some(vec![]),
                domains: Some(vec![]),
                routes: None,
            }),
            packet_filter: Some(
                self.acl
                    .filter_rules_for_node(tenant_id, node_id, &ipv4.to_string()),
            ),
            domain: Some(domain),
            user_profiles: Some(user_profiles),
            keep_alive: None,
            control_time: Some(chrono::Utc::now().to_rfc3339()),
        })
    }

    pub async fn build_delta(&self, event: &PeerEvent) -> Option<MapResponse> {
        match event {
            PeerEvent::NodeJoined { node_id, .. } | PeerEvent::NodeUpdated { node_id, .. } => {
                let detail = self.store.get_node_info(*node_id).await?;
                let node_key = format_key_bytes(&detail.info.node_key);
                let machine_key_str = if detail.info.machine_key.len() == 32 {
                    let mut mk = [0u8; 32];
                    mk.copy_from_slice(&detail.info.machine_key);
                    format_machine_key(&MachineKey(mk))
                } else {
                    String::new()
                };

                let home_region = self
                    .derp
                    .map_for(detail.tenant_id)
                    .regions
                    .keys()
                    .min()
                    .copied()
                    .unwrap_or(1);
                let (addresses, allowed_ips, primary_routes) = coord_core::node_route_sets(
                    &detail.ipv4.to_string(),
                    &detail.attrs.advertised_routes,
                    &detail.attrs.approved_routes,
                );
                let peer = MapNode {
                    id: node_id.as_i64(),
                    stable_id: format!("peer-{}", node_id.as_i64()),
                    name: format!("{}.mesh.local.", node_label(&detail.info.hostname, node_id.as_i64())),
                    user: user_id_for(detail.attrs.owner.as_deref()),
                    key: node_key,
                    machine: machine_key_str,
                    disco_key: detail.info.disco_key.clone(),
                    addresses,
                    allowed_ips,
                    primary_routes,
                    endpoints: detail.info.endpoints.clone(),
                    derp: Some(format!("127.3.3.40:{}", home_region)),
                    home_derp: Some(home_region),
                    hostinfo: minimal_hostinfo(&node_label(&detail.info.hostname, node_id.as_i64())),
                    online: Some(detail.online),
                    last_seen: None,
                    machine_authorized: Some(true),
                    key_expiry: None,
                };

                Some(MapResponse {
                    peers_changed: Some(vec![peer]),
                    // Clients need the profile of a newly seen peer's owner
                    user_profiles: Some(vec![self
                        .identity
                        .profile(detail.tenant_id, detail.attrs.owner.as_deref())]),
                    control_time: Some(chrono::Utc::now().to_rfc3339()),
                    ..Default::default()
                })
            }
            PeerEvent::NodeOffline { node_id, .. } => Some(MapResponse {
                peers_removed: Some(vec![node_id.as_i64()]),
                control_time: Some(chrono::Utc::now().to_rfc3339()),
                ..Default::default()
            }),
        }
    }
}

/// Names are re-sanitised at render time (defence in depth: covers admin
/// renames and rows stored before registration-time sanitisation) so a peer
/// never receives a dotted name that spoofs another FQDN.
fn node_label(hostname: &str, node_id: i64) -> String {
    coord_core::sanitize::node_dns_label(hostname, node_id)
}

/// Tailscale clients dereference `Node.Hostinfo` unconditionally (e.g. in
/// `tailscale status`), so every node we send must carry one — a nil Hostinfo
/// panics the client's LocalAPI.
fn minimal_hostinfo(hostname: &str) -> Option<coord_proto::register::Hostinfo> {
    Some(coord_proto::register::Hostinfo {
        hostname: Some(hostname.to_string()),
        os: None,
        ipn_version: None,
        backend_log_id: None,
        request_tags: None,
        routable_ips: None,
    })
}

fn format_key_bytes(key: &[u8]) -> String {
    if key.len() == 32 {
        let mut k = [0u8; 32];
        k.copy_from_slice(key);
        format_node_key(&k)
    } else {
        hex::encode(key)
    }
}

fn peer_info_to_map_node(p: &coord_core::PeerInfo, home_region: i32) -> MapNode {
    let peer_key = format_key_bytes(&p.node_key);
    let machine_key_str = if p.machine_key.len() == 32 {
        format_machine_key(&MachineKey(p.machine_key.clone().try_into().unwrap()))
    } else {
        String::new()
    };
    // Stores don't track a peer's real home DERP yet; use the tenant map's home region.
    let derp_region = home_region;

    MapNode {
        id: p.node_id.as_i64(),
        stable_id: format!("peer-{}", p.node_id.as_i64()),
        name: format!("{}.mesh.local.", node_label(&p.hostname, p.node_id.as_i64())),
        user: user_id_for(p.owner.as_deref()),
        key: peer_key,
        machine: machine_key_str,
        disco_key: p.disco_key.clone(),
        addresses: p.addresses.clone(),
        allowed_ips: p.allowed_ips.clone(),
        primary_routes: p.primary_routes.clone(),
        endpoints: p.endpoints.clone(),
        derp: Some(format!("127.3.3.40:{}", derp_region)),
        home_derp: Some(derp_region),
        hostinfo: minimal_hostinfo(&node_label(&p.hostname, p.node_id.as_i64())),
        online: Some(p.online),
        last_seen: p.last_seen.map(|t| t.to_rfc3339()),
        machine_authorized: Some(true),
        key_expiry: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn auto_approver_containment_and_tags() {
        let mut aa = AutoApprovers::default();
        aa.routes.insert("10.0.0.0/8".into(), s(&["tag:relay"]));
        aa.exit_node = s(&["tag:exit"]);
        let adv = s(&["10.1.0.0/16", "192.168.0.0/24", "0.0.0.0/0"]);
        assert_eq!(aa.approvable(&s(&["tag:relay"]), &adv), s(&["10.1.0.0/16"]));
        assert_eq!(aa.approvable(&s(&["tag:exit"]), &adv), s(&["0.0.0.0/0"]));
        assert!(aa.approvable(&[], &adv).is_empty());
        assert!(aa.approvable(&s(&["tag:other"]), &adv).is_empty());
    }
}

#[cfg(test)]
mod identity_tests {
    use super::*;

    #[test]
    fn user_ids_are_stable_distinct_and_never_the_legacy_id() {
        assert_eq!(user_id_for(None), 1);
        let a = user_id_for(Some("u-alice"));
        assert_eq!(a, user_id_for(Some("u-alice")));
        assert_ne!(a, user_id_for(Some("u-bob")));
        for o in ["", "a", "b", "u-1", "00000000-0000-0000-0000-000000000000"] {
            let id = user_id_for(Some(o));
            assert!(id > 1 && id < (1i64 << 53), "{o} -> {id}");
        }
    }

    #[test]
    fn sanitized_strips_control_chars_and_blank_names() {
        let mut users = std::collections::BTreeMap::new();
        users.insert("u".into(), UserIdentity { login_name: " al\u{7}ice ".into(), display_name: "A\nB".into() });
        let id = TenantIdentity { tailnet_name: Some("  ".into()), users }.sanitized().unwrap();
        assert_eq!(id.tailnet_name, None);
        assert_eq!(id.users["u"].login_name, "alice");
        assert_eq!(id.users["u"].display_name, "AB");
    }

    #[test]
    fn unknown_owner_gets_placeholder_profile() {
        let reg = IdentityRegistry::new();
        let t = TenantId::new(uuid::Uuid::new_v4());
        let p = reg.profile(t, Some("nobody"));
        assert_eq!(p.login_name, DEFAULT_LOGIN_NAME);
        assert_eq!(reg.domain(t), DEFAULT_DOMAIN);
    }
}
