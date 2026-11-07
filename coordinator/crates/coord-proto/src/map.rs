use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct MapRequest {
    pub version: u16,
    pub node_key: String,
    #[serde(default)]
    pub disco_key: Option<String>,
    #[serde(default)]
    pub endpoints: Option<Vec<String>>,
    #[serde(default)]
    pub stream: Option<bool>,
    #[serde(default)]
    pub compress: Option<String>,
    #[serde(default)]
    pub hostinfo: Option<super::register::Hostinfo>,
    #[serde(rename = "KeepAlive", default)]
    pub keep_alive: Option<bool>,
    #[serde(default)]
    pub omit_peers: Option<bool>,
    #[serde(default)]
    pub read_only: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct MapResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node: Option<MapNode>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub peers: Option<Vec<MapNode>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub peers_changed: Option<Vec<MapNode>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub peers_removed: Option<Vec<i64>>,

    #[serde(rename = "DERPMap", skip_serializing_if = "Option::is_none")]
    pub derp_map: Option<DerpMap>,

    #[serde(rename = "DNSConfig", skip_serializing_if = "Option::is_none")]
    pub dns_config: Option<DnsConfig>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub packet_filter: Option<Vec<FilterRule>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_profiles: Option<Vec<UserProfile>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub keep_alive: Option<bool>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub control_time: Option<String>,
}

/// Matches tailcfg.Node
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct MapNode {
    #[serde(rename = "ID")]
    pub id: i64,

    #[serde(rename = "StableID")]
    pub stable_id: String,

    pub name: String,

    pub user: i64,

    pub key: String,

    #[serde(rename = "Machine")]
    pub machine: String,

    #[serde(rename = "DiscoKey", default, skip_serializing_if = "Option::is_none")]
    pub disco_key: Option<String>,

    pub addresses: Vec<String>,

    #[serde(rename = "AllowedIPs")]
    pub allowed_ips: Vec<String>,

    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub endpoints: Vec<String>,

    #[serde(rename = "DERP", skip_serializing_if = "Option::is_none")]
    pub derp: Option<String>,

    #[serde(rename = "HomeDERP", default, skip_serializing_if = "Option::is_none")]
    pub home_derp: Option<i32>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub hostinfo: Option<super::register::Hostinfo>,

    #[serde(rename = "Online", skip_serializing_if = "Option::is_none")]
    pub online: Option<bool>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine_authorized: Option<bool>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_expiry: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct DerpMap {
    pub regions: std::collections::HashMap<i32, DerpRegion>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub omit_default_regions: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct DerpRegion {
    pub region_id: i32,
    pub region_code: String,
    pub region_name: String,
    pub nodes: Vec<DerpNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct DerpNode {
    pub name: String,
    pub region_id: i32,
    pub host_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cert_name: Option<String>,
    #[serde(rename = "IPv4", default, skip_serializing_if = "Option::is_none")]
    pub ipv4: Option<String>,
    #[serde(rename = "IPv6", default, skip_serializing_if = "Option::is_none")]
    pub ipv6: Option<String>,
    #[serde(rename = "STUNPort")]
    pub stun_port: u16,
    #[serde(rename = "DERPPort")]
    pub derp_port: u16,
    #[serde(rename = "STUNOnly", skip_serializing_if = "Option::is_none")]
    pub stun_only: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub insecure_for_tests: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct DnsConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolvers: Option<Vec<DnsResolver>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domains: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routes: Option<std::collections::HashMap<String, Vec<DnsResolver>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct DnsResolver {
    pub addr: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct FilterRule {
    #[serde(rename = "SrcIPs")]
    pub src_ips: Vec<String>,
    pub dst_ports: Vec<NetPortRange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct NetPortRange {
    #[serde(rename = "IP")]
    pub ip: String,
    pub ports: PortRange,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct PortRange {
    pub first: u16,
    pub last: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct UserProfile {
    #[serde(rename = "ID")]
    pub id: i64,
    pub login_name: String,
    pub display_name: String,
}
