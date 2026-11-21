//! Rate limits for security warnings, so a flood of refused requests cannot flood the log.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Addresses remembered at once. Past this, old entries are dropped first.
const MAX_TRACKED: usize = 4096;

/// Allows one log line per client address per interval and counts the suppressed ones.
pub struct LogLimiter {
    interval: Duration,
    seen: Mutex<HashMap<Option<IpAddr>, Entry>>,
}

struct Entry {
    last: Instant,
    suppressed: u64,
}

impl LogLimiter {
    pub fn new(interval: Duration) -> Self {
        Self { interval, seen: Mutex::new(HashMap::new()) }
    }

    /// `Some(n)` when a line for `ip` may be logged now, with `n` lines suppressed since the last one.
    pub fn check(&self, ip: Option<IpAddr>) -> Option<u64> {
        let now = Instant::now();
        let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = seen.get_mut(&ip) {
            if now.duration_since(entry.last) < self.interval {
                entry.suppressed += 1;
                return None;
            }
            let suppressed = entry.suppressed;
            *entry = Entry { last: now, suppressed: 0 };
            return Some(suppressed);
        }
        if seen.len() >= MAX_TRACKED {
            seen.retain(|_, e| now.duration_since(e.last) < self.interval);
            if seen.len() >= MAX_TRACKED {
                // Every entry is recent: forget them all rather than grow without bound.
                seen.clear();
            }
        }
        seen.insert(ip, Entry { last: now, suppressed: 0 });
        Some(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_line_per_address_per_interval_with_a_count() {
        let limiter = LogLimiter::new(Duration::from_millis(50));
        let a = Some("198.51.100.1".parse().unwrap());
        let b = Some("198.51.100.2".parse().unwrap());
        assert_eq!(limiter.check(a), Some(0));
        assert_eq!(limiter.check(a), None);
        assert_eq!(limiter.check(a), None);
        assert_eq!(limiter.check(b), Some(0), "addresses are limited separately");
        std::thread::sleep(Duration::from_millis(60));
        assert_eq!(limiter.check(a), Some(2), "the next line reports what was suppressed");
    }

    #[test]
    fn memory_stays_bounded() {
        let limiter = LogLimiter::new(Duration::from_secs(60));
        for i in 0..(MAX_TRACKED as u32 + 10) {
            limiter.check(Some(IpAddr::from(i.to_be_bytes())));
        }
        assert!(limiter.seen.lock().unwrap().len() <= MAX_TRACKED);
    }
}
