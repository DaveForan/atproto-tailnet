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
