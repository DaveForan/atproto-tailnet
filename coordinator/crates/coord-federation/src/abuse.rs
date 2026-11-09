//! Rate limiting, replay detection, and pending-request caps for federation
//! endpoints exposed to the internet (ADR-0019 section 4).

use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

// ── Constants ──────────────────────────────────────────────────────────────────

/// Max pending inbound link requests per collective before oldest are expired.
pub const MAX_PENDING_PER_COLLECTIVE: usize = 50;

/// Max body size for federation messages (64 KiB).
pub const MAX_FEDERATION_BODY_BYTES: usize = 65_536;

// ── Rate limiter ───────────────────────────────────────────────────────────────

/// Sliding-window rate limiter keyed by arbitrary string (DID, IP, etc.).
#[derive(Debug)]
pub struct RateLimiter {
    window: Duration,
    max_hits: u32,
    hits: HashMap<String, VecDeque<Instant>>,
    check_count: u64,
}

impl RateLimiter {
    pub fn new(window_ms: u64, max_hits: u32) -> Self {
        Self {
            window: Duration::from_millis(window_ms),
            max_hits,
            hits: HashMap::new(),
            check_count: 0,
        }
    }

    /// Returns `true` if the request is allowed (under the rate limit).
    /// Returns `false` if the request should be rejected.
    pub fn check(&mut self, key: &str) -> bool {
        self.check_count += 1;
        if self.check_count % 128 == 0 {
            self.sweep();
        }

        let now = Instant::now();
        let cutoff = now.checked_sub(self.window).unwrap_or(now);

        let timestamps = self.hits.entry(key.to_string()).or_default();

        // Evict expired entries from the front.
        while let Some(&front) = timestamps.front() {
            if front <= cutoff {
                timestamps.pop_front();
            } else {
                break;
            }
        }

        if timestamps.len() >= self.max_hits as usize {
            return false;
        }

        timestamps.push_back(now);
        true
    }

    /// Remove stale entries. Call periodically to prevent unbounded growth.
    pub fn sweep(&mut self) {
        let now = Instant::now();
        let cutoff = now.checked_sub(self.window).unwrap_or(now);

        self.hits.retain(|_, timestamps| {
            while let Some(&front) = timestamps.front() {
                if front <= cutoff {
                    timestamps.pop_front();
                } else {
                    break;
                }
            }
            !timestamps.is_empty()
        });
    }

    pub fn len(&self) -> usize {
        self.hits.len()
    }

    pub fn is_empty(&self) -> bool {
        self.hits.is_empty()
    }
}

// ── Replay guard ───────────────────────────────────────────────────────────────

/// Message-ID replay cache. Remembers IDs for the freshness window so a
/// captured request cannot be replayed within its validity period.
#[derive(Debug)]
pub struct ReplayGuard {
    window: Duration,
    seen: HashMap<String, Instant>,
}

impl ReplayGuard {
    pub fn new(window: Duration) -> Self {
        Self {
            window,
            seen: HashMap::new(),
        }
    }

    /// Returns `true` if this is the first time we've seen `id` in the window
    /// (i.e., NOT a replay). Returns `false` if it's a duplicate.
    pub fn check(&mut self, id: &str) -> bool {
        self.sweep();
        if self.seen.contains_key(id) {
            return false;
        }
        self.seen.insert(id.to_string(), Instant::now());
        true
    }

    /// Remove expired entries.
    pub fn sweep(&mut self) {
        let cutoff = Instant::now().checked_sub(self.window).unwrap_or(Instant::now());
        self.seen.retain(|_, &mut ts| ts > cutoff);
    }

    pub fn len(&self) -> usize {
        self.seen.len()
    }

    pub fn is_empty(&self) -> bool {
        self.seen.is_empty()
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    #[test]
    fn rate_limiter_allows_up_to_max_hits() {
        let mut limiter = RateLimiter::new(60_000, 3);
        assert!(limiter.check("user-a"));
        assert!(limiter.check("user-a"));
        assert!(limiter.check("user-a"));
        // Fourth hit should be rejected.
        assert!(!limiter.check("user-a"));
        // Different key is still fine.
        assert!(limiter.check("user-b"));
    }

    #[test]
    fn rate_limiter_window_expiry() {
        // Very short window: 50ms.
        let mut limiter = RateLimiter::new(50, 2);
        assert!(limiter.check("key"));
        assert!(limiter.check("key"));
        assert!(!limiter.check("key"));

        // Wait for window to expire.
        thread::sleep(Duration::from_millis(60));

        // Should be allowed again after expiry.
        assert!(limiter.check("key"));
    }

    #[test]
    fn rate_limiter_sweep_cleans_stale() {
        let mut limiter = RateLimiter::new(50, 5);
        limiter.check("a");
        limiter.check("b");
        assert_eq!(limiter.len(), 2);

        thread::sleep(Duration::from_millis(60));
        limiter.sweep();
        assert_eq!(limiter.len(), 0);
    }

    #[test]
    fn replay_guard_blocks_duplicates() {
        let mut guard = ReplayGuard::new(Duration::from_secs(300));
        assert!(guard.check("msg-1")); // first time: OK
        assert!(!guard.check("msg-1")); // duplicate: blocked
        assert!(guard.check("msg-2")); // different ID: OK
    }

    #[test]
    fn replay_guard_window_expiry() {
        let mut guard = ReplayGuard::new(Duration::from_millis(50));
        assert!(guard.check("msg-1"));
        assert!(!guard.check("msg-1"));

        thread::sleep(Duration::from_millis(60));

        // After window expires, same ID should be allowed again.
        assert!(guard.check("msg-1"));
    }

    #[test]
    fn replay_guard_sweep_cleans_expired() {
        let mut guard = ReplayGuard::new(Duration::from_millis(50));
        guard.check("a");
        guard.check("b");
        assert_eq!(guard.len(), 2);

        thread::sleep(Duration::from_millis(60));
        guard.sweep();
        assert_eq!(guard.len(), 0);
    }
}
