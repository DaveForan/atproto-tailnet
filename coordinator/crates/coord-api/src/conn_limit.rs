//! Per-client-address caps on concurrent connections.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};

/// Counts open connections per client address and refuses one over the cap.
pub struct PerIpLimiter {
    max: usize,
    counts: Mutex<HashMap<IpAddr, usize>>,
}

/// One counted connection. Dropping it frees the slot.
pub struct PerIpPermit {
    limiter: Arc<PerIpLimiter>,
    key: IpAddr,
}

impl PerIpLimiter {
    pub fn new(max: usize) -> Arc<Self> {
        Arc::new(Self { max, counts: Mutex::new(HashMap::new()) })
    }

    /// A permit for `ip`, or `None` when the address already holds `max` connections.
    pub fn try_acquire(self: &Arc<Self>, ip: IpAddr) -> Option<PerIpPermit> {
        let key = group(ip);
        let mut counts = self.counts.lock().unwrap_or_else(|e| e.into_inner());
        let count = counts.entry(key).or_insert(0);
        if *count >= self.max {
            return None;
        }
        *count += 1;
        Some(PerIpPermit { limiter: self.clone(), key })
    }

    #[cfg(test)]
    fn count(&self, ip: IpAddr) -> usize {
        self.counts.lock().unwrap_or_else(|e| e.into_inner()).get(&group(ip)).copied().unwrap_or(0)
    }
}

impl Drop for PerIpPermit {
    fn drop(&mut self) {
        let mut counts = self.limiter.counts.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(count) = counts.get_mut(&self.key) {
            *count -= 1;
            if *count == 0 {
                counts.remove(&self.key);
            }
        }
    }
}

/// The unit a cap applies to. One IPv6 host usually owns a whole /64, so the /64 counts as one client.
fn group(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => IpAddr::V6((u128::from(v6) & (u128::MAX << 64)).into()),
        },
        v4 => v4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn caps_each_address_and_frees_slots_on_drop() {
        let limiter = PerIpLimiter::new(2);
        let a = limiter.try_acquire(ip("198.51.100.1")).unwrap();
        let _b = limiter.try_acquire(ip("198.51.100.1")).unwrap();
        assert!(limiter.try_acquire(ip("198.51.100.1")).is_none());
        assert!(limiter.try_acquire(ip("198.51.100.2")).is_some(), "other addresses are not affected");
        drop(a);
        assert!(limiter.try_acquire(ip("198.51.100.1")).is_some());
    }

    #[test]
    fn an_ipv6_slash_64_is_one_client() {
        let limiter = PerIpLimiter::new(1);
        let _a = limiter.try_acquire(ip("2001:db8:1:2::1")).unwrap();
        assert!(limiter.try_acquire(ip("2001:db8:1:2:ffff::9")).is_none());
        assert!(limiter.try_acquire(ip("2001:db8:1:3::1")).is_some());
        let _v4 = limiter.try_acquire(ip("192.0.2.7")).unwrap();
        assert!(limiter.try_acquire(ip("::ffff:192.0.2.7")).is_none(), "mapped IPv4 is the same client");
    }

    #[test]
    fn empty_entries_are_removed() {
        let limiter = PerIpLimiter::new(4);
        drop(limiter.try_acquire(ip("203.0.113.5")).unwrap());
        assert_eq!(limiter.count(ip("203.0.113.5")), 0);
        assert!(limiter.counts.lock().unwrap().is_empty());
    }
}
