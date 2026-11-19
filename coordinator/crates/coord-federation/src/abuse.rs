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

/// Default cap on remembered message keys.
pub const DEFAULT_REPLAY_CAPACITY: usize = 100_000;

/// Message replay cache. Callers key entries on the authenticated sender and a
/// per-message identity (message id or signature) and record them only after
/// the signature verifies, so forged traffic cannot pre-burn keys.
///
/// The window must be at least twice the timestamp freshness skew: a message
/// stays fresh for ±skew around its timestamp, so a shorter retention lets a
/// captured message be replayed while it is still fresh.
///
/// Expiry is amortised O(1) (entries expire in insertion order from a queue);
/// memory is bounded by `capacity` — when full, the oldest entries are evicted.
#[derive(Debug)]
pub struct ReplayGuard {
    window: Duration,
    capacity: usize,
    seen: HashMap<String, Instant>,
    order: VecDeque<(Instant, String)>,
}

impl ReplayGuard {
    pub fn new(window: Duration) -> Self {
        Self::with_capacity(window, DEFAULT_REPLAY_CAPACITY)
    }

    pub fn with_capacity(window: Duration, capacity: usize) -> Self {
        Self {
            window,
            capacity: capacity.max(1),
            seen: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    /// Returns `true` if this is the first time we've seen `id` in the window
    /// (i.e., NOT a replay) and records it. Returns `false` if it's a duplicate.
    pub fn check(&mut self, id: &str) -> bool {
        let now = Instant::now();
        self.expire(now);
        if self.seen.contains_key(id) {
            return false;
        }
        while self.seen.len() >= self.capacity {
            match self.order.pop_front() {
                Some((ts, key)) => self.forget(&key, ts),
                None => break,
            }
        }
        self.seen.insert(id.to_string(), now);
        self.order.push_back((now, id.to_string()));
        true
    }

    /// Remove expired entries.
    pub fn sweep(&mut self) {
        self.expire(Instant::now());
    }

    fn expire(&mut self, now: Instant) {
        while let Some((ts, _)) = self.order.front() {
            if now.saturating_duration_since(*ts) < self.window {
                break;
            }
            if let Some((ts, key)) = self.order.pop_front() {
                self.forget(&key, ts);
            }
        }
    }

    fn forget(&mut self, key: &str, ts: Instant) {
        if self.seen.get(key) == Some(&ts) {
            self.seen.remove(key);
        }
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
    fn replay_guard_is_bounded() {
        let mut guard = ReplayGuard::with_capacity(Duration::from_secs(600), 2);
        assert!(guard.check("a"));
        assert!(guard.check("b"));
        assert!(guard.check("c")); // evicts "a"
        assert_eq!(guard.len(), 2);
        assert!(!guard.check("c"));
        assert!(!guard.check("b"));
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
