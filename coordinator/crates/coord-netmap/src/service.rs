use std::sync::Arc;

use coord_acl::AclEngine;
use coord_acl::PolicyEngine;

use coord_core::keys::{format_machine_key, format_node_key};
use coord_core::{MachineKey, TenantId};
use coord_core::clock;
use coord_proto::map::{DerpMap, FilterRule, MapNode, MapResponse, UserProfile};
use coord_store::Store;

use crate::{
    device_fqdn, dns_view, member_view, service_rules, user_id_for, DerpRegistry, GatewayRegistry, IdentityRegistry,
};

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

        // Security: a device that waits for admission gets its own node and nothing else.
        // No peers, no names, and an empty filter that blocks all traffic.
        if detail.attrs.hold.is_held() {
            let label = node_label(&detail.info.hostname, node_id.as_i64());
            let owner = detail.attrs.owner.as_deref();
            return Ok(MapResponse {
                node: Some(MapNode {
                    id: node_id.as_i64(),
                    stable_id: detail.stable_id,
                    name: label.clone(),
                    user: user_id_for(owner),
                    key: node_key_str,
                    machine: format_machine_key(&MachineKey(*machine_key)),
                    disco_key: None,
                    addresses: self_addresses,
                    allowed_ips: vec![],
                    primary_routes: vec![],
                    endpoints: vec![],
                    derp: None,
                    home_derp: None,
                    hostinfo: minimal_hostinfo(&label),
                    online: Some(true),
                    last_seen: None,
                    machine_authorized: Some(false),
                    key_expiry: None,
                }),
                peers: None,
                peers_changed: None,
                peers_removed: None,
                derp_map: None,
                dns_config: None,
                packet_filter: Some(vec![]),
                domain: Some(self.identity.domain(tenant_id)),
                user_profiles: Some(self.profiles_for(tenant_id, std::iter::once(owner))),
                keep_alive: None,
                control_time: Some(clock::to_rfc3339(clock::now())),
            });
        }

        let dns = self.store.get_tenant_dns(tenant_id).await;
        let access = self.store.get_tenant_access(tenant_id).await;
        // Security: only the owner puts a device under the tenant's open policy (ADR-0036).
        // Every other device keeps the member view, whatever the tenant's mode is.
        let self_open = access.is_open_for(detail.attrs.owner.as_deref());
        let children = self.store.get_child_tenants(tenant_id).await;
        // The member view is tenant-scoped: child tenants' devices never show through it.
        let all_peers = if children.is_empty() || !self_open {
            self.store.get_peers(tenant_id, node_id).await
        } else {
            self.store.get_peers_with_children(tenant_id, node_id).await
        };
        let gateway = self.gateways.get(tenant_id);
        // HTTPS services open only two paths: viewers to the gateway, and the gateway to the published port.
        // These rules hold in both modes, so an ACL policy cannot block a published service.
        let mut rules = access.rules.clone();
        if let Some(gw) = gateway {
            let everyone: Vec<i64> = all_peers.iter().map(|p| p.node_id.as_i64()).chain([node_id.as_i64()]).filter(|id| *id != gw).collect();
            rules.extend(service_rules(&dns, gw, &everyone));
        }
        let view = member_view(node_id.as_i64(), detail.attrs.owner.as_deref(), &ipv4.to_string(), &all_peers, &rules);
        let (peers, packet_filter): (Vec<coord_core::PeerInfo>, Vec<FilterRule>) = if self_open {
            // An open device sees the other open devices, and the devices that the rules link it to.
            let linked: std::collections::HashSet<i64> = view.peers.iter().map(|p| p.node_id.as_i64()).collect();
            let peers = all_peers
                .iter()
                .filter(|p| access.is_open_for(p.owner.as_deref()) || linked.contains(&p.node_id.as_i64()))
                .cloned()
                .collect();
            // The tenant's ACL policy, or allow-all. Then what the rules open.
            let mut filter = self.acl.filter_rules_for_node(tenant_id, node_id, &ipv4.to_string());
            filter.extend(view.filter);
            (peers, filter)
        } else {
            // An empty list blocks everything.
            (view.peers.into_iter().cloned().collect(), view.filter)
        };
        let derp_map = self.derp.map_for(tenant_id);
        let default_region = derp_map.regions.keys().min().copied().unwrap_or(1);
        // Each device's reported home relay, when this map has it.
        // Peers send through the device's home relay, so relays need no inter-region link (ADR-0034).
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
            dns_config: Some(dns_view(node_id.as_i64(), self_owner, &ipv4.to_string(), &peers, &dns, gateway, self.gateways.service_domain())),
            packet_filter: Some(packet_filter),
            domain: Some(domain),
            user_profiles: Some(user_profiles),
            keep_alive: None,
            control_time: Some(clock::to_rfc3339(clock::now())),
        })
    }

}

/// Re-sanitise at render time as defence in depth, for admin renames and old rows.
/// A peer never receives a dotted name that spoofs another FQDN.
fn node_label(hostname: &str, node_id: i64) -> String {
    coord_core::sanitize::node_dns_label(hostname, node_id)
}

/// Tailscale clients dereference `Node.Hostinfo` unconditionally. A nil Hostinfo panics the LocalAPI.
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

/// The home relay region to tell peers: the reported one if this map has it, else the default.
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
        last_seen: p.last_seen.map(clock::to_rfc3339),
        machine_authorized: Some(true),
        key_expiry: None,
    }
}
