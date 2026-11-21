use coord_proto::map::{DnsConfig, DnsExtraRecord, DnsResolver};

/// Suffix of device names without a tenant DNS configuration.
pub const LEGACY_DEVICE_SUFFIX: &str = "mesh.local";

/// Device FQDN: `<label>.<tailnet>.<base_domain>.` with tenant DNS, else `<label>.mesh.local.`.
pub fn device_fqdn(label: &str, dns: &coord_core::TenantDns) -> String {
    match dns.device_suffix() {
        Some(suffix) => format!("{label}.{suffix}."),
        None => format!("{label}.{LEGACY_DEVICE_SUFFIX}."),
    }
}

/// The DNS configuration one device receives (ADR-0028).
/// The split-DNS route needs upstreams. Without them, clients answer NXDOMAIN for every unrecorded name.
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
        // An HTTPS service resolves to the gateway. Every other name resolves to its device.
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
