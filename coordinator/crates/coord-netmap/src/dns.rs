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
/// HTTPS service names are under `service_domain` when it is set (ADR-0038).
pub fn dns_view(
    self_id: i64,
    self_owner: Option<&str>,
    self_ip: &str,
    visible_peers: &[coord_core::PeerInfo],
    dns: &coord_core::TenantDns,
    gateway: Option<i64>,
    service_domain: Option<&str>,
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
            let domain = if r.port.is_some() { service_domain.unwrap_or(base) } else { base };
            Some(DnsExtraRecord { name: format!("{}.{domain}", r.name), value: address_of(node)? })
        })
        .collect();
    // A device sends a lookup to its Tailscale resolver only for a domain in `domains` or `routes`.
    // Service names sit outside the tailnet suffix, so without a route the OS asks public DNS.
    // An empty resolver list makes the client authoritative: unknown service names get NXDOMAIN.
    let mut routes = std::collections::HashMap::new();
    if !dns.upstream.is_empty() {
        let resolvers = dns.upstream.iter().map(|addr| DnsResolver { addr: addr.clone() }).collect();
        routes.insert(base.to_string(), resolvers);
    }
    if let Some(domain) = service_domain.filter(|d| *d != base) {
        routes.entry(domain.to_string()).or_default();
    }
    let routes = (!routes.is_empty()).then_some(routes);
    let suffix = dns.device_suffix();
    DnsConfig {
        resolvers: Some(vec![]),
        domains: Some(suffix.iter().cloned().collect()),
        routes,
        proxied: suffix.is_some().then_some(true),
        extra_records: (!records.is_empty()).then_some(records),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use coord_core::{DnsRecord, TenantDns};

    fn dns(upstream: &[&str]) -> TenantDns {
        TenantDns {
            base_domain: Some("ts.example.com".into()),
            tailnet_label: Some("quiet-harbor".into()),
            upstream: upstream.iter().map(|s| s.to_string()).collect(),
            records: vec![DnsRecord { name: "app".into(), node: 1, owner: None, nodes: vec![], port: Some(8080) }],
        }
    }

    #[test]
    fn service_domain_gets_an_authoritative_route() {
        let view = dns_view(1, None, "100.64.0.1", &[], &dns(&[]), Some(7), Some("svc.ts.example.com"));
        let routes = view.routes.expect("routes");
        assert_eq!(routes.get("svc.ts.example.com").map(Vec::len), Some(0));
        assert!(!routes.contains_key("ts.example.com"));
    }

    #[test]
    fn upstream_route_and_service_route_coexist() {
        let view = dns_view(1, None, "100.64.0.1", &[], &dns(&["9.9.9.9"]), Some(7), Some("svc.ts.example.com"));
        let routes = view.routes.expect("routes");
        assert_eq!(routes["ts.example.com"].len(), 1);
        assert_eq!(routes["svc.ts.example.com"].len(), 0);
    }

    #[test]
    fn no_service_domain_means_no_route() {
        let view = dns_view(1, None, "100.64.0.1", &[], &dns(&[]), None, None);
        assert!(view.routes.is_none());
        let view = dns_view(1, None, "100.64.0.1", &[], &dns(&[]), None, Some("ts.example.com"));
        assert!(view.routes.is_none(), "the base domain must never get an empty route");
    }
}
