//! Relay regions (ADR-0027, ADR-0034).

use serde::{Deserialize, Serialize};

/// Region ids that relay processes of the instance may use. Ids 900-999 are
/// for the custom regions of tenants.
pub const RELAY_REGION_MIN: i32 = 1;
pub const RELAY_REGION_MAX: i32 = 899;
/// A relay writes its row this often.
pub const RELAY_HEARTBEAT_SECS: u64 = 20;
/// A relay whose row is older than this is left out of the DERP map.
pub const RELAY_STALE_SECS: i64 = 75;

/// One live relay process: its DERP region and public hostname.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelayInfo {
    pub region_id: i32,
    pub hostname: String,
    /// 0 = no STUN on this relay.
    pub stun_port: u16,
}

/// The public keys of the gateway that a relay process runs for one tenant (ADR-0038).
/// The relay offers them; a control process registers the gateway node from them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GatewayOffer {
    pub node_key: [u8; 32],
    pub machine_key: [u8; 32],
    pub disco_key: [u8; 32],
    /// The DERP region of the relay that runs the gateway.
    pub region_id: i32,
    /// The public UDP addresses of the gateway (ADR-0029 phase 2). Empty: devices use the relay.
    #[serde(default)]
    pub endpoints: Vec<std::net::SocketAddr>,
}

/// The most endpoints a gateway offer can have.
pub const MAX_GATEWAY_ENDPOINTS: usize = 8;
