pub mod pool;
pub mod memory;
pub mod pg;
pub mod sqlite;
mod dispatch;

pub use pool::{create_pool, create_sqlite_pool};
pub use memory::{MemoryStore, PeerEvent, TenantRouteSnapshot};
pub use pg::PgStore;
pub use sqlite::SqliteStore;
pub use dispatch::Store;

const PEER_EVENT_CHANNEL_CAPACITY: usize = 256;

/// Something that happened on another coordinator replica (ADR-0034). Only
/// the PostgreSQL backend has other replicas; the others never emit these.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteEvent {
    /// A tenant's configuration, access rules, DNS or suspension changed.
    TenantChanged(coord_core::TenantId),
    /// A pending device sign-in was decided.
    SignInDecided(String),
    /// Notifications may have been lost (the LISTEN connection dropped and
    /// came back): every cached tenant and every live stream must resync from
    /// the store. Raised locally only; never carried in a NOTIFY payload.
    Resync,
}

/// A session generation read from a BIGINT column.
///
/// # Errors
/// A negative stored value (the column only ever counts up from 0).
pub(crate) fn generation_from_db(stored: i64) -> Result<u64, coord_core::CoordError> {
    u64::try_from(stored).map_err(|_| coord_core::CoordError::Protocol(format!("stored session generation {stored} is negative")))
}

/// A session generation for a BIGINT column.
///
/// # Errors
/// A value above `i64::MAX`, which the store never hands out.
pub(crate) fn generation_to_db(generation: u64) -> Result<i64, coord_core::CoordError> {
    i64::try_from(generation).map_err(|_| coord_core::CoordError::Protocol(format!("session generation {generation} does not fit the store")))
}

pub(crate) fn now_secs() -> i64 {
    chrono::Utc::now().timestamp()
}

/// Columns read for a pending sign-in, in the order `sign_in_from_row` expects.
pub(crate) const SIGN_IN_COLUMNS: &str = "machine_key, hostname, os, decision, requester_ip, requested_at, expires_at";

pub(crate) type SignInRow = (String, String, String, Option<String>, Option<String>, Option<i64>, i64);

/// Shared row decoding for pending sign-ins (PostgreSQL and SQLite).
pub(crate) fn sign_in_from_row(row: SignInRow) -> Option<coord_core::PendingSignIn> {
    let (machine_key, hostname, os, decision, requester_ip, requested_at, expires_at) = row;
    let machine_key: [u8; 32] = hex::decode(machine_key).ok()?.try_into().ok()?;
    // Rows from before requested_at existed: started one TTL before expiry
    let started = requested_at.unwrap_or(expires_at - coord_core::signin::SIGN_IN_TTL_SECS);
    Some(coord_core::PendingSignIn {
        machine_key,
        hostname,
        os,
        decision: decision.and_then(|d| serde_json::from_str(&d).ok()),
        requester_ip,
        requested_at: chrono::DateTime::from_timestamp(started, 0).unwrap_or_default(),
    })
}

/// Pre-auth keys are bearer credentials, so they get 256 bits of entropy.
pub(crate) fn generate_auth_key() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 32];
    rand::rng().fill_bytes(&mut buf);
    format!("tskey-auth-{}", hex::encode(buf))
}

/// How a pre-auth key is stored and looked up: SHA-256 of the key, lowercase
/// hex. The key itself is never stored (ADR-0035 hardening).
pub fn hash_preauth_key(key: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(key.as_bytes()))
}

/// A short, non-secret tag of a presented key for logs (first 8 hex digits of
/// its hash): lets an operator correlate attempts without logging the key.
pub fn preauth_key_log_id(key: &str) -> String {
    hash_preauth_key(key)[..8].to_string()
}

pub(crate) fn generate_random_id() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 8];
    rand::rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

/// First and last addresses of the node IPv4 range (CGNAT 100.64.0.0/10). The
/// range is instance-global: tenant `ipv4_prefix` is informational today and
/// `coord_nodes.ipv4` is UNIQUE across all tenants.
const IPV4_BASE: u32 = u32::from_be_bytes([100, 64, 0, 0]);
const IPV4_LAST: u32 = u32::from_be_bytes([100, 127, 255, 255]);

/// Addresses Tailscale clients treat specially and that must never be handed to
/// a node: 100.100.100.0/24 (quad-100 MagicDNS/peerapi service IPs) and
/// 100.115.92.0/23 (ChromeOS/ARC).
fn is_reserved_ipv4(ip: u32) -> bool {
    (ip & 0xFFFF_FF00) == u32::from_be_bytes([100, 100, 100, 0])
        || (ip & 0xFFFF_FE00) == u32::from_be_bytes([100, 115, 92, 0])
}

/// Lowest node address (starting at 100.64.0.1) that no live node holds.
/// Every backend calls this while holding its allocation lock, so freed
/// addresses (deleted / swept ephemeral nodes) are reused and all backends
/// allocate identically.
pub(crate) fn lowest_free_ipv4<I>(used: I) -> Result<std::net::Ipv4Addr, coord_core::CoordError>
where
    I: IntoIterator<Item = std::net::Ipv4Addr>,
{
    let used: std::collections::HashSet<u32> = used.into_iter().map(u32::from).collect();
    let mut candidate = IPV4_BASE + 1;
    while candidate <= IPV4_LAST {
        if !used.contains(&candidate) && !is_reserved_ipv4(candidate) {
            return Ok(std::net::Ipv4Addr::from(candidate));
        }
        candidate += 1;
    }
    Err(coord_core::CoordError::AddressSpaceExhausted)
}

#[cfg(test)]
mod ipv4_alloc_tests {
    use super::*;
    use std::net::Ipv4Addr;

    #[test]
    fn picks_lowest_gap_and_skips_reserved() {
        assert_eq!(lowest_free_ipv4([]).unwrap(), Ipv4Addr::new(100, 64, 0, 1));
        let used = [Ipv4Addr::new(100, 64, 0, 1), Ipv4Addr::new(100, 64, 0, 3)];
        assert_eq!(lowest_free_ipv4(used).unwrap(), Ipv4Addr::new(100, 64, 0, 2));
        assert!(is_reserved_ipv4(u32::from(Ipv4Addr::new(100, 100, 100, 100))));
        assert!(is_reserved_ipv4(u32::from(Ipv4Addr::new(100, 115, 93, 7))));
        assert!(!is_reserved_ipv4(u32::from(Ipv4Addr::new(100, 115, 94, 0))));
    }
}

#[cfg(test)]
mod generation_tests {
    use super::{generation_from_db, generation_to_db};

    #[test]
    fn generations_convert_only_when_they_fit() {
        assert_eq!(generation_from_db(7).unwrap(), 7);
        assert!(generation_from_db(-1).is_err());
        assert_eq!(generation_to_db(7).unwrap(), 7);
        assert_eq!(generation_to_db(u64::try_from(i64::MAX).unwrap()).unwrap(), i64::MAX);
        assert!(generation_to_db(u64::MAX).is_err());
    }
}
