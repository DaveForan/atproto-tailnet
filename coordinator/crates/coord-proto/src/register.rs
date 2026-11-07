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
}

/// Matches tailcfg.RegisterResponse
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

/// Matches tailcfg.User
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct User {
    #[serde(rename = "ID")]
    pub id: i64,
    #[serde(default)]
    pub display_name: String,
}

/// Matches tailcfg.Login
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
