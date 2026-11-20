use coord_proto::map::{FilterRule, NetPortRange, PortRange};

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
