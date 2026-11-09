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

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct NodeKey(pub [u8; 32]);

#[derive(Clone, PartialEq, Eq, Hash)]
pub struct ControlKey {
    pub public: [u8; 32],
    pub secret: [u8; 32],
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
    pub fn generate() -> Self {
        use rand::RngCore;
        let mut secret = [0u8; 32];
        rand::rng().fill_bytes(&mut secret);
        let public = x25519_public_from_secret(&secret);
        Self { public, secret }
    }
}

fn x25519_public_from_secret(secret: &[u8; 32]) -> [u8; 32] {
    use curve25519_dalek::montgomery::MontgomeryPoint;
    use curve25519_dalek::scalar::Scalar;
    let clamped = clamp_scalar(secret);
    let scalar = Scalar::from_bytes_mod_order(clamped);
    let point = MontgomeryPoint::mul_base(&scalar);
    point.to_bytes()
}

fn clamp_scalar(secret: &[u8; 32]) -> [u8; 32] {
    let mut clamped = *secret;
    clamped[0] &= 248;
    clamped[31] &= 127;
    clamped[31] |= 64;
    clamped
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
    pub disco_key: Option<String>,
    pub endpoints: Vec<String>,
    pub allowed_ips: Vec<String>,
    pub hostname: String,
    pub derp_region: Option<i32>,
    pub online: bool,
    pub last_seen: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FederationPosture {
    Closed,
    Selective,
    Open,
}

impl Default for FederationPosture {
    fn default() -> Self {
        Self::Closed
    }
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AclVerdict {
    Allow,
    Deny,
}

// ── Federation types (Tier 3) ─────────────────────────────────────────────

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
