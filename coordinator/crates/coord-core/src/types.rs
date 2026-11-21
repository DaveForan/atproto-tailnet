use std::net::Ipv4Addr;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TenantId(Uuid);

impl TenantId {
    pub fn new(id: Uuid) -> Self {
        Self(id)
    }

    pub fn generate() -> Self {
        Self(Uuid::new_v4())
    }

    pub fn as_uuid(&self) -> &Uuid {
        &self.0
    }
}

impl std::fmt::Display for TenantId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct NodeId(i64);

impl NodeId {
    pub fn new(id: i64) -> Self {
        Self(id)
    }

    pub fn as_i64(&self) -> i64 {
        self.0
    }
}

impl std::fmt::Display for NodeId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct MachineKey(pub [u8; 32]);

#[derive(Clone, PartialEq, Eq, Hash)]
pub struct ControlKey {
    pub public: [u8; 32],
    secret: [u8; 32],
}

impl std::fmt::Debug for ControlKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ControlKey")
            .field("public", &hex::encode(self.public))
            .field("secret", &"[REDACTED]")
            .finish()
    }
}

impl ControlKey {
    pub fn new(public: [u8; 32], secret: [u8; 32]) -> Self {
        Self { public, secret }
    }

    pub fn secret(&self) -> &[u8; 32] {
        &self.secret
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeInfo {
    pub node_key: Vec<u8>,
    pub machine_key: Vec<u8>,
    pub disco_key: Option<String>,
    pub endpoints: Vec<String>,
    pub hostname: String,
    pub os: String,
    pub ipv4: Option<String>,
    pub ipv6: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerInfo {
    pub node_id: NodeId,
    pub node_key: Vec<u8>,
    pub machine_key: Vec<u8>,
    pub disco_key: Option<String>,
    pub endpoints: Vec<String>,
    /// The node's own tailnet addresses (e.g. `100.64.0.1/32`).
    pub addresses: Vec<String>,
    /// addresses + effective (approved ∩ advertised) routes.
    pub allowed_ips: Vec<String>,
    /// Effective subnet routes this node serves (exit routes excluded).
    pub primary_routes: Vec<String>,
    pub hostname: String,
    pub derp_region: Option<i32>,
    pub online: bool,
    pub last_seen: Option<chrono::DateTime<chrono::Utc>>,
    /// The TS service's user id, inherited from the node's pre-auth key.
    pub owner: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FederationPosture {
    #[default]
    Closed,
    /// Not implemented: the admin API refuses it, and stored rows behave as Closed.
    Selective,
    Open,
}

impl FederationPosture {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Closed => "closed",
            Self::Selective => "selective",
            Self::Open => "open",
        }
    }
}

impl std::str::FromStr for FederationPosture {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "open" => Ok(Self::Open),
            "selective" => Ok(Self::Selective),
            "closed" => Ok(Self::Closed),
            other => Err(format!("unknown federation posture: {other}")),
        }
    }
}

pub const DEFAULT_IPV4_PREFIX: &str = "100.64.0.0/10";
pub const DEFAULT_IPV6_PREFIX: &str = "fd7a:115c:a1e0::/48";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tenant {
    pub id: TenantId,
    pub slug: String,
    pub parent_id: Option<TenantId>,
    pub federation_posture: FederationPosture,
    pub ipv4_prefix: String,
    pub ipv6_prefix: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    /// Operator suspension. A suspended tenant cannot register nodes, poll the map, or mint pre-auth keys.
    #[serde(default)]
    pub suspended: bool,
}

impl Tenant {
    /// Whether a parent tenant's nodes may see this child tenant's nodes.
    /// Only Open shares. Selective is not implemented, so it fails safe as Closed.
    pub fn visible_to_parent(&self) -> bool {
        self.federation_posture == FederationPosture::Open && !self.suspended
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AclVerdict {
    Allow,
    Deny,
}


#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct LinkId(Uuid);

impl LinkId {
    pub fn new(id: Uuid) -> Self {
        Self(id)
    }

    pub fn generate() -> Self {
        Self(Uuid::new_v4())
    }

    pub fn as_uuid(&self) -> &Uuid {
        &self.0
    }
}

impl std::fmt::Display for LinkId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SessionId(Uuid);

impl SessionId {
    pub fn new(id: Uuid) -> Self {
        Self(id)
    }

    pub fn generate() -> Self {
        Self(Uuid::new_v4())
    }

    pub fn as_uuid(&self) -> &Uuid {
        &self.0
    }
}

impl std::fmt::Display for SessionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkDirection {
    Incoming,
    Outgoing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkStatus {
    Pending,
    Active,
    Rejected,
    Revoked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrokerSessionStatus {
    Connecting,
    Established,
    Degraded,
    Disconnected,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FederationLink {
    pub id: LinkId,
    pub local_tenant_id: TenantId,
    pub peer_did: String,
    pub peer_broker_url: Option<String>,
    pub peer_name: Option<String>,
    pub direction: LinkDirection,
    pub status: LinkStatus,
    pub local_cidrs: Vec<String>,
    pub peer_cidrs: Vec<String>,
    pub protocol_version: Option<String>,
    pub message: Option<String>,
    pub signed_request: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerSession {
    pub id: SessionId,
    pub federation_link_id: LinkId,
    pub local_tenant_id: TenantId,
    pub peer_did: String,
    pub status: BrokerSessionStatus,
    pub cfp_session_id: Option<String>,
    pub remote_endpoint: Option<String>,
    pub protocol_version: Option<String>,
    pub exported_routes: Vec<String>,
    pub imported_routes: Vec<String>,
    pub last_keepalive: Option<chrono::DateTime<chrono::Utc>>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectiveDid {
    pub tenant_id: TenantId,
    pub did: String,
    pub public_key_jwk: serde_json::Value,
    pub encrypted_private_key: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

/// Ownership / routing attributes of a node.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeAttrs {
    pub owner: Option<String>,
    pub tags: Vec<String>,
    pub ephemeral: bool,
    pub advertised_routes: Vec<String>,
    pub approved_routes: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct NodeSummary {
    pub id: NodeId,
    pub tenant_id: TenantId,
    pub ipv4: Ipv4Addr,
    pub stable_id: String,
    pub online: bool,
    pub hostname: String,
    pub attrs: NodeAttrs,
}

#[derive(Debug, Clone)]
pub struct NodeDetail {
    pub tenant_id: TenantId,
    pub ipv4: Ipv4Addr,
    pub stable_id: String,
    pub info: NodeInfo,
    pub online: bool,
    pub attrs: NodeAttrs,
}

/// Grant-derived attributes for `register_node_with`. They replace a known machine's values.
/// `advertised_routes: None` keeps the advertised set.
/// A changed owner or tag set clears approved routes, because approvals belong to the old identity.
#[derive(Debug, Clone, Default)]
pub struct NodeRegistration {
    pub owner: Option<String>,
    pub tags: Vec<String>,
    pub ephemeral: bool,
    pub advertised_routes: Option<Vec<String>>,
}

/// Tag of the coordinator's own gateway node (ADR-0029). Auth keys cannot carry it.
pub const GATEWAY_TAG: &str = "tag:gateway";
/// Device name of the gateway node. No other node of a tenant gets this name.
pub const GATEWAY_HOSTNAME: &str = "gateway";

/// True when `owner` and `tags` identify the coordinator's gateway node.
pub fn is_gateway_identity(owner: Option<&str>, tags: &[String]) -> bool {
    owner.is_none() && tags.iter().any(|t| t == GATEWAY_TAG)
}


#[derive(Debug, Clone, Default)]
pub struct PreAuthKeyOptions {
    pub reusable: bool,
    pub ephemeral: bool,
    pub expires_at: Option<chrono::DateTime<chrono::Utc>>,
    pub owner: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct CreatedPreAuthKey {
    pub id: Uuid,
    pub key: String,
    pub tenant_id: TenantId,
    pub expires_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// Listing view of a pre-auth key. It never carries the full secret.
#[derive(Debug, Clone)]
pub struct PreAuthKeyInfo {
    pub id: Uuid,
    pub tenant_id: TenantId,
    pub prefix: String,
    pub owner: Option<String>,
    pub tags: Vec<String>,
    pub reusable: bool,
    pub ephemeral: bool,
    pub used: bool,
    pub expires_at: Option<chrono::DateTime<chrono::Utc>>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub revoked: bool,
}

/// What a successfully consumed pre-auth key grants the registering node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreAuthGrant {
    pub tenant_id: TenantId,
    pub owner: Option<String>,
    pub tags: Vec<String>,
    pub ephemeral: bool,
}

pub const PREAUTH_KEY_PREFIX_LEN: usize = 12;

pub fn preauth_key_prefix(key: &str) -> String {
    key.chars().take(PREAUTH_KEY_PREFIX_LEN).collect()
}

/// (addresses, allowed_ips, primary_routes) for a node, given its routes.
pub fn node_route_sets(
    ipv4: &str,
    advertised: &[String],
    approved: &[String],
) -> (Vec<String>, Vec<String>, Vec<String>) {
    let addresses = vec![format!("{}/32", ipv4)];
    let effective = crate::routes::effective_routes(advertised, approved);
    let mut allowed = addresses.clone();
    allowed.extend(effective.iter().cloned());
    let primary = effective
        .into_iter()
        .filter(|r| !crate::routes::is_exit_route(r))
        .collect();
    (addresses, allowed, primary)
}

pub fn is_valid_slug(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() || bytes.len() > 63 {
        return false;
    }
    if !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit() {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

pub fn is_valid_hostname(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() || bytes.len() > 253 {
        return false;
    }
    if !bytes[0].is_ascii_alphanumeric() {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|&b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
}
