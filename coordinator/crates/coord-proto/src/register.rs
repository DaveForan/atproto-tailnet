use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct RegisterRequest {
    pub version: u16,
    pub node_key: String,
    #[serde(default)]
    pub old_node_key: Option<String>,
    #[serde(default)]
    pub auth: Option<AuthInfo>,
    #[serde(default)]
    pub hostinfo: Option<Hostinfo>,
    #[serde(default)]
    pub followup: Option<String>,
    #[serde(default)]
    pub ephemeral: Option<bool>,
    #[serde(default)]
    pub timestamp: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct AuthInfo {
    #[serde(default)]
    pub auth_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct Hostinfo {
    #[serde(default)]
    pub hostname: Option<String>,
    #[serde(rename = "OS", default)]
    pub os: Option<String>,
    #[serde(rename = "IPNVersion", default)]
    pub ipn_version: Option<String>,
    #[serde(rename = "BackendLogID", default)]
    pub backend_log_id: Option<String>,
    #[serde(default)]
    pub request_tags: Option<Vec<String>>,
    /// Subnet and exit routes that the node advertises.
    #[serde(rename = "RoutableIPs", default, skip_serializing_if = "Option::is_none")]
    pub routable_ips: Option<Vec<String>>,
    /// Network facts the client measured; only the home relay is used.
    #[serde(rename = "NetInfo", default, skip_serializing_if = "Option::is_none")]
    pub net_info: Option<NetInfo>,
}

/// Matches the part of tailcfg.NetInfo that the coordinator uses.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NetInfo {
    /// The DERP region the client chose as its home (0 = none yet).
    #[serde(rename = "PreferredDERP", default)]
    pub preferred_derp: i32,
}

/// Matches tailcfg.RegisterResponse.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct RegisterResponse {
    pub user: User,
    pub login: Login,
    #[serde(default)]
    pub node_key_expired: bool,
    pub machine_authorized: bool,
    #[serde(rename = "AuthURL", default)]
    pub auth_url: String,
    #[serde(default)]
    pub error: String,
}

/// Matches tailcfg.User.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct User {
    #[serde(rename = "ID")]
    pub id: i64,
    #[serde(default)]
    pub display_name: String,
}

/// Matches tailcfg.Login.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct Login {
    #[serde(rename = "ID")]
    pub id: i64,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub login_name: String,
    #[serde(default)]
    pub display_name: String,
}
