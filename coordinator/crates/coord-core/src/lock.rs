//! Owner machine locks (ADR-0035 §2): limit a member's devices to a fixed set of machines.
//! A lock refuses unlisted machine keys, even with a valid pre-auth key or approved sign-in.
//! The Noise handshake proves the machine key, so it identifies the machine, not the account.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Refused attempts remembered per lock, newest last.
pub const MAX_REFUSED_KEPT: usize = 20;
/// Machines one lock can hold.
pub const MAX_LOCK_MACHINES: usize = 64;
/// Longest "allow one new machine" window.
pub const MAX_ALLOW_WINDOW_SECS: i64 = 30 * 60;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RefusedMachine {
    pub at: DateTime<Utc>,
    pub hostname: String,
    pub os: String,
    /// Short fingerprint of the refused machine key.
    pub fingerprint: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnerLock {
    /// Machine keys (lowercase hex) that may register.
    pub machines: Vec<String>,
    /// Until this time, the next new machine joins the set and the window closes.
    #[serde(default)]
    pub allow_one_until: Option<DateTime<Utc>>,
    #[serde(default)]
    pub refused: Vec<RefusedMachine>,
    /// Owner-set machine limit. `None` means [`MAX_LOCK_MACHINES`].
    #[serde(default)]
    pub max_machines: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockOutcome {
    /// The machine is in the set.
    Allowed,
    /// The one-time window let a new machine in. The lock changed.
    AllowedNew,
    /// The machine is not in the set. The lock records the attempt.
    Refused,
}

/// What the store holds for one (tenant, owner).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LockRead {
    /// No lock: the owner may register any machine.
    Unlocked,
    Locked(OwnerLock),
    /// The row does not decode. It fails closed: no machine may register until an admin resets it.
    Malformed,
}

impl LockRead {
    pub fn lock(&self) -> Option<&OwnerLock> {
        match self {
            LockRead::Locked(l) => Some(l),
            _ => None,
        }
    }

    pub fn is_locked(&self) -> bool {
        !matches!(self, LockRead::Unlocked)
    }
}

/// What an atomic lock update writes back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LockWrite {
    Keep,
    Set(OwnerLock),
    Remove,
}

/// Registration decision for one machine, run inside `Store::update_owner_lock`. `None` means no lock.
pub fn registration_check(
    read: LockRead,
    machine_key_hex: &str,
    now: DateTime<Utc>,
    hostname: &str,
    os: &str,
    fingerprint: &str,
) -> (LockWrite, Option<LockOutcome>) {
    match read {
        LockRead::Unlocked => (LockWrite::Keep, None),
        // An unreadable row cannot be updated, so refuse and leave it.
        LockRead::Malformed => (LockWrite::Keep, Some(LockOutcome::Refused)),
        LockRead::Locked(mut lock) => {
            let outcome = lock.check(machine_key_hex, now, hostname, os, fingerprint);
            let write = if outcome == LockOutcome::Allowed { LockWrite::Keep } else { LockWrite::Set(lock) };
            (write, Some(outcome))
        }
    }
}

impl OwnerLock {
    pub fn capacity(&self) -> usize {
        self.max_machines.map_or(MAX_LOCK_MACHINES, |m| (m as usize).min(MAX_LOCK_MACHINES))
    }

    pub fn is_full(&self) -> bool {
        self.machines.len() >= self.capacity()
    }

    pub fn allows(&self, machine_key_hex: &str) -> bool {
        self.machines.iter().any(|m| m == machine_key_hex)
    }

    /// Decides whether a machine may register. Consumes the window or records a refusal.
    pub fn check(
        &mut self,
        machine_key_hex: &str,
        now: DateTime<Utc>,
        hostname: &str,
        os: &str,
        fingerprint: &str,
    ) -> LockOutcome {
        if self.allows(machine_key_hex) {
            return LockOutcome::Allowed;
        }
        if self.allow_one_until.is_some_and(|until| now < until) && !self.is_full() {
            self.machines.push(machine_key_hex.to_string());
            self.allow_one_until = None;
            return LockOutcome::AllowedNew;
        }
        self.allow_one_until = None;
        self.refused.push(RefusedMachine {
            at: now,
            hostname: hostname.chars().take(64).collect(),
            os: os.chars().take(32).collect(),
            fingerprint: fingerprint.to_string(),
        });
        if self.refused.len() > MAX_REFUSED_KEPT {
            let extra = self.refused.len() - MAX_REFUSED_KEPT;
            self.refused.drain(..extra);
        }
        LockOutcome::Refused
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-11-20T12:00:00Z").unwrap().with_timezone(&Utc)
    }

    #[test]
    fn listed_machines_pass_and_others_are_refused_and_recorded() {
        let mut lock = OwnerLock { machines: vec!["aa".into()], ..Default::default() };
        assert_eq!(lock.check("aa", now(), "mac", "macOS", "f1"), LockOutcome::Allowed);
        assert!(lock.refused.is_empty());
        assert_eq!(lock.check("bb", now(), "evil-box", "linux", "f2"), LockOutcome::Refused);
        assert_eq!(lock.refused.len(), 1);
        assert_eq!(lock.refused[0].hostname, "evil-box");
        assert!(!lock.allows("bb"));
    }

    #[test]
    fn the_window_admits_exactly_one_new_machine() {
        let mut lock = OwnerLock {
            machines: vec!["aa".into()],
            allow_one_until: Some(now() + chrono::Duration::minutes(10)),
            ..Default::default()
        };
        assert_eq!(lock.check("bb", now(), "phone", "iOS", "f"), LockOutcome::AllowedNew);
        assert!(lock.allows("bb"));
        assert_eq!(lock.allow_one_until, None);
        assert_eq!(lock.check("cc", now(), "third", "linux", "f"), LockOutcome::Refused);
    }

    #[test]
    fn an_expired_window_admits_nobody_and_a_refusal_closes_it() {
        let mut lock = OwnerLock {
            machines: vec!["aa".into()],
            allow_one_until: Some(now() - chrono::Duration::seconds(1)),
            ..Default::default()
        };
        assert_eq!(lock.check("bb", now(), "late", "linux", "f"), LockOutcome::Refused);
        assert_eq!(lock.allow_one_until, None);
    }

    #[test]
    fn a_full_lock_admits_nobody_even_inside_the_window() {
        let mut lock = OwnerLock {
            machines: vec!["aa".into(), "bb".into()],
            allow_one_until: Some(now() + chrono::Duration::minutes(10)),
            max_machines: Some(2),
            ..Default::default()
        };
        assert!(lock.is_full());
        assert_eq!(lock.check("cc", now(), "third", "linux", "f"), LockOutcome::Refused);
        assert_eq!(lock.check("aa", now(), "known", "linux", "f"), LockOutcome::Allowed);
        lock.max_machines = Some(3);
        lock.allow_one_until = Some(now() + chrono::Duration::minutes(10));
        assert_eq!(lock.check("cc", now(), "third", "linux", "f"), LockOutcome::AllowedNew);
    }

    #[test]
    fn registration_check_fails_closed_on_a_malformed_lock() {
        assert_eq!(registration_check(LockRead::Unlocked, "aa", now(), "h", "o", "f"), (LockWrite::Keep, None));
        assert_eq!(
            registration_check(LockRead::Malformed, "aa", now(), "h", "o", "f"),
            (LockWrite::Keep, Some(LockOutcome::Refused))
        );
        let lock = OwnerLock { machines: vec!["aa".into()], ..Default::default() };
        assert_eq!(
            registration_check(LockRead::Locked(lock.clone()), "aa", now(), "h", "o", "f"),
            (LockWrite::Keep, Some(LockOutcome::Allowed))
        );
        let (write, outcome) = registration_check(LockRead::Locked(lock), "bb", now(), "h", "o", "f");
        assert_eq!(outcome, Some(LockOutcome::Refused));
        assert!(matches!(write, LockWrite::Set(l) if l.refused.len() == 1));
    }

    #[test]
    fn refused_history_is_bounded_and_fields_are_clipped() {
        let mut lock = OwnerLock::default();
        for i in 0..(MAX_REFUSED_KEPT + 5) {
            lock.check(&format!("k{i}"), now(), &"h".repeat(200), "os", "f");
        }
        assert_eq!(lock.refused.len(), MAX_REFUSED_KEPT);
        assert_eq!(lock.refused[0].hostname.len(), 64);
    }
}
