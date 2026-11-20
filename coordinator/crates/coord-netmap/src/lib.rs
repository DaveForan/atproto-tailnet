use std::sync::Arc;

use coord_acl::AclEngine;
use coord_acl::PolicyEngine;
use std::collections::HashMap;
use std::sync::RwLock;

use coord_core::keys::{format_machine_key, format_node_key};
use coord_core::routes::Cidr;
use coord_core::{MachineKey, TenantId};
use coord_proto::map::{DerpMap, DerpRegion, DnsConfig, DnsExtraRecord, DnsResolver, FilterRule, MapNode, MapResponse, NetPortRange, PortRange, UserProfile};
use coord_store::{PeerEvent, Store};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TenantDerp {
    pub custom_regions: HashMap<i32, DerpRegion>,
    pub include_default: bool,
}

/// Operator-wide default DERP map plus per-tenant overrides.
///
/// The default map is the configured base map plus one region for each live
/// relay process that control replicas discover in the store (ADR-0034).
pub struct DerpRegistry {
    base: DerpMap,
    default: RwLock<DerpMap>,
    tenants: RwLock<HashMap<TenantId, TenantDerp>>,
}

impl DerpRegistry {
    pub fn new(default: DerpMap) -> Self {
        Self { base: default.clone(), default: RwLock::new(default), tenants: RwLock::new(HashMap::new()) }
    }

    pub fn default_map(&self) -> DerpMap {
        self.default.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Set the regions of the discovered relays. A discovered region replaces
    /// a base region with the same id. Returns true when the default map changed.
    pub fn set_relay_regions(&self, regions: Vec<DerpRegion>) -> bool {
        let mut next = self.base.clone();
        for region in regions {
            next.regions.insert(region.region_id, region);
        }
        let mut current = self.default.write().unwrap_or_else(|e| e.into_inner());
        let same = serde_json::to_value(&*current).ok() == serde_json::to_value(&next).ok();
        *current = next;
        !same
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
        let default = self.default_map();
        let Some(cfg) = self.get_tenant(tenant) else {
            return default;
        };
        let mut regions = if cfg.include_default {
            default.regions
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

/// The gateway node of each tenant that has one (ADR-0029). A cache of the
/// `gateway` tenant configuration in the store.
#[derive(Default)]
pub struct GatewayRegistry {
    tenants: RwLock<HashMap<TenantId, i64>>,
}

impl GatewayRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(&self, tenant: TenantId, node_id: i64) {
        self.tenants.write().unwrap_or_else(|e| e.into_inner()).insert(tenant, node_id);
    }

    pub fn get(&self, tenant: TenantId) -> Option<i64> {
        self.tenants.read().unwrap_or_else(|e| e.into_inner()).get(&tenant).copied()
    }

    pub fn remove(&self, tenant: TenantId) {
        self.tenants.write().unwrap_or_else(|e| e.into_inner()).remove(&tenant);
    }
}

/// The access rules that HTTPS services need in a `member`-mode tailnet
/// (ADR-0030): the devices that may see a service reach the gateway on its
/// web ports, and the gateway reaches the published port of the device.
/// `everyone` lists all devices of the tailnet except the gateway, for
/// services that every device may see.
pub fn service_rules(dns: &coord_core::TenantDns, gateway: i64, everyone: &[i64]) -> Vec<coord_core::AccessRule> {
    use coord_core::{AccessPort, AccessProto, AccessRule};
    let tcp = |port: u16| AccessPort { proto: AccessProto::Tcp, first: port, last: port };
    let mut rules = Vec::new();
    for record in dns.records.iter().filter(|r| r.port.is_some() && r.node != gateway) {
        let Some(port) = record.port else { continue };
        let to_gateway = |src_owner: Option<String>, src_nodes: Vec<i64>| AccessRule {
            src_owner,
            src_nodes,
            dst_node: gateway,
            ports: coord_core::dns::GATEWAY_PORTS.iter().map(|p| tcp(*p)).collect(),
        };
        if record.owner.is_none() && record.nodes.is_empty() {
            rules.push(to_gateway(None, everyone.to_vec()));
        } else {
            // `visible_to` is "listed device, or device of the owner": one rule for each
            if !record.nodes.is_empty() {
                rules.push(to_gateway(None, record.nodes.clone()));
            }
            if record.owner.is_some() {
                rules.push(to_gateway(record.owner.clone(), Vec::new()));
            }
        }
        rules.push(AccessRule { src_owner: None, src_nodes: vec![gateway], dst_node: record.node, ports: vec![tcp(port)] });
    }
    rules
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

/// Suffix of device names without a tenant DNS configuration.
pub const LEGACY_DEVICE_SUFFIX: &str = "mesh.local";

/// Fully-qualified name of a device: `<label>.<tailnet>.<base_domain>.` when
/// the tenant has DNS configured, else `<label>.mesh.local.`.
pub fn device_fqdn(label: &str, dns: &coord_core::TenantDns) -> String {
    match dns.device_suffix() {
        Some(suffix) => format!("{label}.{suffix}."),
        None => format!("{label}.{LEGACY_DEVICE_SUFFIX}."),
    }
}

/// The DNS configuration one device receives (ADR-0028).
///
/// - A split-DNS route for the base domain, only when upstream resolvers are
///   set: a route without resolvers makes the client answer NXDOMAIN for
///   every name under the domain that has no record.
/// - The service records this device may see, pointing at devices it can see.
/// - A search domain and MagicDNS for device names.
pub fn dns_view(
    self_id: i64,
    self_owner: Option<&str>,
    self_ip: &str,
    visible_peers: &[coord_core::PeerInfo],
    dns: &coord_core::TenantDns,
    gateway: Option<i64>,
) -> DnsConfig {
    let Some(base) = dns.base_domain.as_deref() else {
        return DnsConfig { resolvers: Some(vec![]), domains: Some(vec![]), routes: None, proxied: None, extra_records: None };
    };
    let address_of = |node: i64| -> Option<String> {
        if node == self_id {
            return Some(self_ip.to_string());
        }
        let peer = visible_peers.iter().find(|p| p.node_id.as_i64() == node)?;
        Some(peer.addresses.first()?.split('/').next()?.to_string())
    };
    let records: Vec<DnsExtraRecord> = dns
        .records
        .iter()
        .filter(|r| r.visible_to(self_id, self_owner))
        // An HTTPS service resolves to the gateway, which passes the request
        // on; every other name resolves to its device.
        .filter_map(|r| {
            let node = match (r.port, gateway) {
                (Some(_), Some(gw)) => gw,
                _ => r.node,
            };
            Some(DnsExtraRecord { name: format!("{}.{base}", r.name), value: address_of(node)? })
        })
        .collect();
    let routes = (!dns.upstream.is_empty()).then(|| {
        let resolvers = dns.upstream.iter().map(|addr| DnsResolver { addr: addr.clone() }).collect();
        std::collections::HashMap::from([(base.to_string(), resolvers)])
    });
    let suffix = dns.device_suffix();
    DnsConfig {
        resolvers: Some(vec![]),
        domains: Some(suffix.iter().cloned().collect()),
        routes,
        proxied: suffix.is_some().then_some(true),
        extra_records: (!records.is_empty()).then_some(records),
    }
}

/// What one device sees and accepts in a `member`-mode tenant (ADR-0036).
pub struct MemberView<'a> {
    /// Peers the device can reach or that can reach it.
    pub peers: Vec<&'a coord_core::PeerInfo>,
    /// Who may send to the device, and on which ports.
    pub filter: Vec<FilterRule>,
}

/// Compute the peer list and packet filter of device `self_id` in a
/// `member`-mode tenant: devices of the same owner reach each other on every
/// port, and each access rule opens the listed ports of its destination
/// device to its source devices. An unowned device has no "own devices".
pub fn member_view<'a>(
    self_id: i64,
    self_owner: Option<&str>,
    self_ip: &str,
    peers: &'a [coord_core::PeerInfo],
    rules: &[coord_core::AccessRule],
) -> MemberView<'a> {
    use std::collections::BTreeMap;
    let all_ports = |ip: &str| NetPortRange { ip: ip.to_string(), ports: PortRange { first: 0, last: 65535 } };
    let same_owner = |p: &coord_core::PeerInfo| self_owner.is_some() && p.owner.as_deref() == self_owner;

    let mut filter = Vec::new();
    let own_sources: Vec<String> = peers.iter().filter(|p| same_owner(p)).flat_map(|p| p.addresses.clone()).collect();
    if !own_sources.is_empty() {
        filter.push(FilterRule { src_ips: own_sources, dst_ports: vec![all_ports(self_ip)], ip_proto: None });
    }

    for rule in rules.iter().filter(|r| r.dst_node == self_id) {
        let sources: Vec<String> = peers
            .iter()
            .filter(|p| !same_owner(p) && rule.src_matches(p.node_id.as_i64(), p.owner.as_deref()))
            .flat_map(|p| p.addresses.clone())
            .collect();
        if sources.is_empty() {
            continue;
        }
        // One filter rule per protocol (a rule carries one protocol list)
        let mut by_proto: BTreeMap<coord_core::AccessProto, Vec<NetPortRange>> = BTreeMap::new();
        for port in &rule.ports {
            let range = match port.proto {
                coord_core::AccessProto::Icmp => all_ports(self_ip),
                _ => NetPortRange { ip: self_ip.to_string(), ports: PortRange { first: port.first, last: port.last } },
            };
            by_proto.entry(port.proto).or_default().push(range);
        }
        for (proto, dst_ports) in by_proto {
            filter.push(FilterRule { src_ips: sources.clone(), dst_ports, ip_proto: proto.ip_protos() });
        }
    }

    let visible = peers
        .iter()
        .filter(|p| {
            let pid = p.node_id.as_i64();
            same_owner(p)
                || rules.iter().any(|r| {
                    (r.dst_node == self_id && r.src_matches(pid, p.owner.as_deref()))
                        || (r.dst_node == pid && r.src_matches(self_id, self_owner))
                })
        })
        .collect();

    MemberView { peers: visible, filter }
}

pub struct NetmapService {
    store: Arc<Store>,
    acl: Arc<PolicyEngine>,
    derp: Arc<DerpRegistry>,
    identity: Arc<IdentityRegistry>,
    gateways: Arc<GatewayRegistry>,
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
        Self { store, acl, derp, identity, gateways: Arc::new(GatewayRegistry::new()) }
    }

    /// Use this registry of gateway nodes (ADR-0029).
    pub fn with_gateways(mut self, gateways: Arc<GatewayRegistry>) -> Self {
        self.gateways = gateways;
        self
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

        let dns = self.store.get_tenant_dns(tenant_id).await;
        let access = self.store.get_tenant_access(tenant_id).await;
        let member_mode = access.mode == coord_core::AccessMode::Member;
        let children = self.store.get_child_tenants(tenant_id).await;
        // Member mode is scoped to the tenant itself: devices of child
        // tenants are never visible through it.
        let all_peers = if children.is_empty() || member_mode {
            self.store.get_peers(tenant_id, node_id).await
        } else {
            self.store.get_peers_with_children(tenant_id, node_id).await
        };
        let gateway = self.gateways.get(tenant_id);
        let member = member_mode.then(|| {
            // HTTPS services open two paths: viewers to the gateway, and the
            // gateway to the published port. Nothing else.
            let mut rules = access.rules.clone();
            if let Some(gw) = gateway {
                let everyone: Vec<i64> = all_peers.iter().map(|p| p.node_id.as_i64()).chain([node_id.as_i64()]).filter(|id| *id != gw).collect();
                rules.extend(service_rules(&dns, gw, &everyone));
            }
            member_view(node_id.as_i64(), detail.attrs.owner.as_deref(), &ipv4.to_string(), &all_peers, &rules)
        });
        let (peers, member_filter): (Vec<coord_core::PeerInfo>, Option<Vec<FilterRule>>) = match member {
            Some(view) => (view.peers.into_iter().cloned().collect(), Some(view.filter)),
            None => (all_peers, None),
        };
        let derp_map = self.derp.map_for(tenant_id);
        let default_region = derp_map.regions.keys().min().copied().unwrap_or(1);
        // Each device's own home relay, when it reported one that is in this map.
        // A peer sends to a device through the device's home relay, so relays
        // in different regions need no link between them (ADR-0034).
        let mut ids: Vec<coord_core::NodeId> = peers.iter().map(|p| p.node_id).collect();
        ids.push(node_id);
        let reported = self.store.home_relays(&ids).await;
        let region_of = |id: coord_core::NodeId| home_region_for(reported.get(&id).copied(), &derp_map, default_region);
        let home_region = region_of(node_id);
        let peer_nodes: Vec<MapNode> = peers
            .iter()
            .map(|p| peer_info_to_map_node(p, region_of(p.node_id), &dns))
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
            name: device_fqdn(&node_label(&detail.info.hostname, node_id.as_i64()), &dns),
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
            dns_config: Some(dns_view(node_id.as_i64(), self_owner, &ipv4.to_string(), &peers, &dns, gateway)),
            // Member mode: per-device filter (an empty list blocks everything).
            // Otherwise the tenant's ACL policy, or allow-all.
            packet_filter: Some(member_filter.unwrap_or_else(|| {
                self.acl
                    .filter_rules_for_node(tenant_id, node_id, &ipv4.to_string())
            })),
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

                let derp_map = self.derp.map_for(detail.tenant_id);
                let default_region = derp_map.regions.keys().min().copied().unwrap_or(1);
                let reported = self.store.home_relays(&[*node_id]).await.get(node_id).copied();
                let home_region = home_region_for(reported, &derp_map, default_region);
                let (addresses, allowed_ips, primary_routes) = coord_core::node_route_sets(
                    &detail.ipv4.to_string(),
                    &detail.attrs.advertised_routes,
                    &detail.attrs.approved_routes,
                );
                let peer = MapNode {
                    id: node_id.as_i64(),
                    stable_id: format!("peer-{}", node_id.as_i64()),
                    name: device_fqdn(
                        &node_label(&detail.info.hostname, node_id.as_i64()),
                        &self.store.get_tenant_dns(detail.tenant_id).await,
                    ),
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
        net_info: None,
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

/// The home relay region to tell peers: the one the device reported when it
/// is a region of this map, otherwise the map's default region.
pub fn home_region_for(reported: Option<i32>, map: &DerpMap, default_region: i32) -> i32 {
    reported.filter(|r| map.regions.contains_key(r)).unwrap_or(default_region)
}

fn peer_info_to_map_node(p: &coord_core::PeerInfo, home_region: i32, dns: &coord_core::TenantDns) -> MapNode {
    let peer_key = format_key_bytes(&p.node_key);
    let machine_key_str = if p.machine_key.len() == 32 {
        format_machine_key(&MachineKey(p.machine_key.clone().try_into().unwrap()))
    } else {
        String::new()
    };
    let derp_region = home_region;

    MapNode {
        id: p.node_id.as_i64(),
        stable_id: format!("peer-{}", p.node_id.as_i64()),
        name: device_fqdn(&node_label(&p.hostname, p.node_id.as_i64()), dns),
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

#[cfg(test)]
mod member_view_tests {
    use super::*;
    use coord_core::{AccessPort, AccessProto, AccessRule, NodeId, PeerInfo};

    fn peer(id: i64, owner: Option<&str>) -> PeerInfo {
        PeerInfo {
            node_id: NodeId::new(id),
            node_key: vec![id as u8; 32],
            machine_key: vec![id as u8; 32],
            disco_key: None,
            endpoints: vec![],
            addresses: vec![format!("100.64.0.{id}/32")],
            allowed_ips: vec![format!("100.64.0.{id}/32")],
            primary_routes: vec![],
            hostname: format!("n{id}"),
            derp_region: Some(1),
            online: true,
            last_seen: None,
            owner: owner.map(Into::into),
        }
    }

    fn rule(src_owner: &str, src_nodes: Vec<i64>, dst: i64, ports: Vec<(AccessProto, u16, u16)>) -> AccessRule {
        AccessRule {
            src_owner: Some(src_owner.into()),
            src_nodes,
            dst_node: dst,
            ports: ports.into_iter().map(|(proto, first, last)| AccessPort { proto, first, last }).collect(),
        }
    }

    fn ids(v: &MemberView) -> Vec<i64> {
        v.peers.iter().map(|p| p.node_id.as_i64()).collect()
    }

    // Device 1 and 2 belong to alice, 3 and 4 to bob, 5 has no owner.
    fn others_of(self_id: i64) -> Vec<PeerInfo> {
        [(1, Some("alice")), (2, Some("alice")), (3, Some("bob")), (4, Some("bob")), (5, None)]
            .into_iter()
            .filter(|(id, _)| *id != self_id)
            .map(|(id, o)| peer(id, o))
            .collect()
    }

    #[test]
    fn default_is_own_devices_only() {
        let peers = others_of(1);
        let v = member_view(1, Some("alice"), "100.64.0.1", &peers, &[]);
        assert_eq!(ids(&v), vec![2]);
        assert_eq!(v.filter.len(), 1);
        assert_eq!(v.filter[0].src_ips, vec!["100.64.0.2/32"]);
        assert_eq!(v.filter[0].dst_ports[0].ip, "100.64.0.1");
        assert_eq!((v.filter[0].dst_ports[0].ports.first, v.filter[0].dst_ports[0].ports.last), (0, 65535));
    }

    #[test]
    fn unowned_device_sees_nothing_and_accepts_nothing() {
        let peers = others_of(5);
        let v = member_view(5, None, "100.64.0.5", &peers, &[]);
        assert!(v.peers.is_empty());
        assert!(v.filter.is_empty(), "an empty filter blocks everything");
    }

    #[test]
    fn rule_opens_only_the_listed_port_of_the_destination() {
        // bob's devices may reach alice's device 1 on tcp/3000
        let rules = vec![rule("bob", vec![], 1, vec![(AccessProto::Tcp, 3000, 3000)])];

        // Destination side: device 1 accepts from 3 and 4 on tcp/3000, plus its own devices
        let peers = others_of(1);
        let v = member_view(1, Some("alice"), "100.64.0.1", &peers, &rules);
        assert_eq!(ids(&v), vec![2, 3, 4]);
        let shared = v.filter.iter().find(|f| f.ip_proto == Some(vec![6])).expect("tcp rule");
        assert_eq!(shared.src_ips, vec!["100.64.0.3/32", "100.64.0.4/32"]);
        assert_eq!((shared.dst_ports[0].ports.first, shared.dst_ports[0].ports.last), (3000, 3000));

        // Source side: device 3 sees device 1 (to connect) but accepts nothing from it
        let peers = others_of(3);
        let v = member_view(3, Some("bob"), "100.64.0.3", &peers, &rules);
        assert_eq!(ids(&v), vec![1, 4]);
        assert!(v.filter.iter().all(|f| !f.src_ips.contains(&"100.64.0.1/32".to_string())));

        // alice's other device 2 is not opened by the rule
        let peers = others_of(2);
        let v = member_view(2, Some("alice"), "100.64.0.2", &peers, &rules);
        assert_eq!(ids(&v), vec![1]);
    }

    #[test]
    fn rule_can_name_specific_source_devices() {
        let rules = vec![rule("bob", vec![4], 1, vec![(AccessProto::Any, 22, 22)])];
        let peers = others_of(1);
        let v = member_view(1, Some("alice"), "100.64.0.1", &peers, &rules);
        assert_eq!(ids(&v), vec![2, 4]);
        let shared = v.filter.iter().find(|f| f.dst_ports[0].ports.first == 22).unwrap();
        assert_eq!(shared.src_ips, vec!["100.64.0.4/32"]);
        assert_eq!(shared.ip_proto, None);

        // bob's device 3 is not in the rule: it does not even see device 1
        let peers = others_of(3);
        assert_eq!(ids(&member_view(3, Some("bob"), "100.64.0.3", &peers, &rules)), vec![4]);
    }

    #[test]
    fn protocols_become_separate_filter_rules() {
        let rules = vec![rule(
            "bob",
            vec![],
            1,
            vec![(AccessProto::Tcp, 80, 80), (AccessProto::Tcp, 443, 443), (AccessProto::Udp, 53, 53), (AccessProto::Icmp, 0, 0)],
        )];
        let peers = others_of(1);
        let v = member_view(1, Some("alice"), "100.64.0.1", &peers, &rules);
        let tcp = v.filter.iter().find(|f| f.ip_proto == Some(vec![6])).unwrap();
        assert_eq!(tcp.dst_ports.len(), 2);
        assert!(v.filter.iter().any(|f| f.ip_proto == Some(vec![17])));
        let icmp = v.filter.iter().find(|f| f.ip_proto == Some(vec![1, 58])).unwrap();
        assert_eq!((icmp.dst_ports[0].ports.first, icmp.dst_ports[0].ports.last), (0, 65535));
    }
}
