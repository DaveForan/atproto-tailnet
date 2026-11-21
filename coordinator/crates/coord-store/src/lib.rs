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

use coord_core::clock;

const PEER_EVENT_CHANNEL_CAPACITY: usize = 256;

/// An event from another coordinator replica (ADR-0034).
/// Only the PostgreSQL backend has other replicas, so only it emits these.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteEvent {
    /// A tenant's configuration, access rules, DNS or suspension changed.
    TenantChanged(coord_core::TenantId),
    /// A pending device sign-in was decided.
    SignInDecided(String),
    /// Notifications may be lost because the LISTEN connection reconnected.
    /// All cached tenants and live streams must resync from the store.
    /// Raised locally only, never sent in a NOTIFY payload.
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
    clock::now().unix_timestamp()
}

/// Columns read for a pending sign-in, in the order `sign_in_from_row` expects.
pub(crate) const SIGN_IN_COLUMNS: &str = "machine_key, hostname, os, decision, requester_ip, requested_at, expires_at";

pub(crate) type SignInRow = (String, String, String, Option<String>, Option<String>, Option<i64>, i64);

/// Shared row decoding for pending sign-ins (PostgreSQL and SQLite).
pub(crate) fn sign_in_from_row(row: SignInRow) -> Option<coord_core::PendingSignIn> {
    let (machine_key, hostname, os, decision, requester_ip, requested_at, expires_at) = row;
    let machine_key: [u8; 32] = hex::decode(machine_key).ok()?.try_into().ok()?;
    // Legacy rows lack requested_at: assume the request started one TTL before expiry
    let started = requested_at.unwrap_or(expires_at - coord_core::signin::SIGN_IN_TTL_SECS);
    Some(coord_core::PendingSignIn {
        machine_key,
        hostname,
        os,
        decision: decision.and_then(|d| serde_json::from_str(&d).ok()),
        requester_ip,
        requested_at: clock::from_unix(started).unwrap_or(clock::EPOCH),
    })
}

/// Pre-auth keys are bearer credentials, so they get 256 bits of entropy.
pub(crate) fn generate_auth_key() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 32];
    rand::rng().fill_bytes(&mut buf);
    format!("tskey-auth-{}", hex::encode(buf))
}

/// SHA-256 of a pre-auth key as lowercase hex, used to store and look it up.
/// The store never keeps the key itself (ADR-0035).
pub fn hash_preauth_key(key: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(key.as_bytes()))
}

/// A non-secret log tag for a key: the first 8 hex digits of its hash.
/// It lets an operator correlate attempts without logging the key.
pub fn preauth_key_log_id(key: &str) -> String {
    hash_preauth_key(key)[..8].to_string()
}

/// A device name whose DNS label no other tenant node uses, so MagicDNS names do not collide.
/// A taken label gets the lowest free `-N` suffix. Only the gateway may use [`coord_core::GATEWAY_HOSTNAME`].
/// A name without a usable label stays as is: the netmap shows it as the unique `node-<id>`.
pub(crate) fn unique_hostname<'a, I>(desired: &str, is_gateway: bool, others: I) -> String
where
    I: IntoIterator<Item = (i64, &'a str)>,
{
    use coord_core::sanitize::{dns_label, node_dns_label, MAX_DNS_LABEL_LEN};
    let Some(label) = dns_label(desired) else { return desired.to_string() };
    if is_gateway {
        return desired.to_string();
    }
    let mut taken: std::collections::HashSet<String> =
        others.into_iter().map(|(id, name)| node_dns_label(name, id)).collect();
    taken.insert(coord_core::GATEWAY_HOSTNAME.to_string());
    if !taken.contains(&label) {
        return desired.to_string();
    }
    // At most taken.len() candidates are taken, so the loop ends.
    for n in 1..=taken.len() + 1 {
        let suffix = format!("-{n}");
        let mut base = label.clone();
        base.truncate(MAX_DNS_LABEL_LEN - suffix.len());
        let candidate = format!("{}{suffix}", base.trim_end_matches('-'));
        if !taken.contains(&candidate) {
            return candidate;
        }
    }
    unreachable!("a free suffix exists among taken.len() + 1 candidates")
}

/// Checks that `parent` may become the parent of `tenant`.
/// The hierarchy has one level: a parent is a root tenant, and a tenant with children gets no parent.
///
/// # Errors
/// `TenantNotFound(parent)` for a missing parent; `Protocol` for itself, a descendant or a second level.
pub(crate) fn check_new_parent(
    tenant: coord_core::TenantId,
    parent: coord_core::TenantId,
    parent_row: Option<&coord_core::Tenant>,
    tenant_has_children: bool,
) -> Result<(), coord_core::CoordError> {
    use coord_core::CoordError;
    if parent == tenant {
        return Err(CoordError::Protocol("a tenant cannot be its own parent".into()));
    }
    let parent_row = parent_row.ok_or(CoordError::TenantNotFound(parent))?;
    if parent_row.parent_id == Some(tenant) {
        return Err(CoordError::Protocol("the parent is a descendant of the tenant".into()));
    }
    if parent_row.parent_id.is_some() {
        return Err(CoordError::Protocol("multi-level hierarchy not supported: parent is itself a child".into()));
    }
    if tenant_has_children {
        return Err(CoordError::Protocol("multi-level hierarchy not supported: the tenant has children".into()));
    }
    Ok(())
}

/// Checks the parent of a new tenant. `parent_is_child` is `None` when the parent does not exist.
/// Call it under the hierarchy lock, so a parallel `set_tenant_parent` cannot change the answer.
///
/// # Errors
/// `TenantNotFound(parent)` for a missing parent; `Protocol` when the parent is itself a child.
pub(crate) fn check_create_parent(
    parent: coord_core::TenantId,
    parent_is_child: Option<bool>,
) -> Result<(), coord_core::CoordError> {
    match parent_is_child {
        None => Err(coord_core::CoordError::TenantNotFound(parent)),
        Some(true) => Err(coord_core::CoordError::Protocol(
            "multi-level hierarchy not supported: parent is itself a child".into(),
        )),
        Some(false) => Ok(()),
    }
}

pub(crate) fn generate_random_id() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 8];
    rand::rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

/// First and last node IPv4 addresses (CGNAT 100.64.0.0/10).
/// The range is instance-global: `coord_nodes.ipv4` is UNIQUE across all tenants.
/// Tenant `ipv4_prefix` is informational only.
const IPV4_BASE: u32 = u32::from_be_bytes([100, 64, 0, 0]);
const IPV4_LAST: u32 = u32::from_be_bytes([100, 127, 255, 255]);

/// Addresses Tailscale clients treat specially and that must never be handed to
/// a node: 100.100.100.0/24 (quad-100 MagicDNS/peerapi service IPs) and
/// 100.115.92.0/23 (ChromeOS/ARC).
fn is_reserved_ipv4(ip: u32) -> bool {
    (ip & 0xFFFF_FF00) == u32::from_be_bytes([100, 100, 100, 0])
        || (ip & 0xFFFF_FE00) == u32::from_be_bytes([100, 115, 92, 0])
}

/// Lowest node address from 100.64.0.1 up that no live node holds.
/// Callers hold their allocation lock. Freed addresses get reused, and all backends allocate identically.
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
mod hostname_tests {
    use super::unique_hostname;

    #[test]
    fn taken_names_get_the_lowest_free_suffix() {
        assert_eq!(unique_hostname("laptop", false, []), "laptop");
        assert_eq!(unique_hostname("laptop", false, [(1, "Laptop")]), "laptop-1");
        assert_eq!(unique_hostname("laptop", false, [(1, "laptop"), (2, "laptop-2")]), "laptop-1");
        assert_eq!(unique_hostname("laptop", false, [(1, "laptop"), (2, "laptop-1")]), "laptop-2");
        // Labels compare after sanitising: "My.Laptop" is "my-laptop" in DNS
        assert_eq!(unique_hostname("my-laptop", false, [(1, "My.Laptop")]), "my-laptop-1");
        // A nameless node is node-<id> in DNS
        assert_eq!(unique_hostname("node-7", false, [(7, "")]), "node-7-1");
        assert_eq!(unique_hostname("", false, [(1, "")]), "");
    }

    #[test]
    fn the_gateway_name_is_reserved() {
        assert_eq!(unique_hostname("gateway", false, []), "gateway-1");
        assert_eq!(unique_hostname("GATEWAY", false, [(1, "gateway-1")]), "gateway-2");
        assert_eq!(unique_hostname("gateway", true, [(1, "gateway")]), "gateway");
    }

    #[test]
    fn suffixed_names_stay_valid_labels() {
        let long = "a".repeat(63);
        let name = unique_hostname(&long, false, [(1, long.as_str())]);
        assert_eq!(name.len(), 63);
        assert!(name.ends_with("-1"));
        let dashy = format!("{}-b", "a".repeat(60));
        let name = unique_hostname(&dashy, false, [(1, dashy.as_str())]);
        assert!(!name.contains("--") && name.len() <= 63, "{name}");
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
