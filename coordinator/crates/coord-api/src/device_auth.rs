//! Interactive device sign-in (ADR-0032).
//!
//! A device that registers without a pre-auth key gets a sign-in URL. The
//! user opens it, signs in on the dashboard and approves the device; the TS
//! service then tells the coordinator which tenant and owner the device
//! belongs to. Meanwhile the device waits on a follow-up register request.
//!
//! Pending sign-ins live in memory: they are short-lived, and a device simply
//! starts again after a coordinator restart.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use coord_core::TenantId;
use rand::RngCore;
use tokio::sync::Notify;

/// How long a sign-in link stays valid.
pub const PENDING_TTL: Duration = Duration::from_secs(10 * 60);
/// Pending sign-ins kept at once; the oldest are dropped beyond this.
pub const MAX_PENDING: usize = 10_000;
/// Longest a device's follow-up request waits before it is told to ask again.
pub const FOLLOWUP_WAIT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Pending,
    Approved { tenant_id: TenantId, owner: String },
    Denied,
}

#[derive(Debug, Clone)]
pub struct PendingDevice {
    pub machine_key: [u8; 32],
    pub hostname: String,
    pub os: String,
    pub created: Instant,
    pub decision: Decision,
}

#[derive(Default)]
pub struct DeviceAuthRegistry {
    pending: Mutex<HashMap<String, PendingDevice>>,
    changed: Notify,
}

impl DeviceAuthRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, PendingDevice>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Start a sign-in for a machine and return its id (128 random bits, hex).
    /// A machine has one pending sign-in at a time: a new one replaces the old.
    pub fn start(&self, machine_key: [u8; 32], hostname: String, os: String) -> String {
        let mut id_bytes = [0u8; 16];
        rand::rng().fill_bytes(&mut id_bytes);
        let id = hex::encode(id_bytes);
        let mut pending = self.lock();
        let now = Instant::now();
        pending.retain(|_, p| p.machine_key != machine_key && now.duration_since(p.created) < PENDING_TTL);
        if pending.len() >= MAX_PENDING {
            if let Some(oldest) = pending.iter().min_by_key(|(_, p)| p.created).map(|(k, _)| k.clone()) {
                pending.remove(&oldest);
            }
        }
        pending.insert(id.clone(), PendingDevice { machine_key, hostname, os, created: now, decision: Decision::Pending });
        id
    }

    /// The pending sign-in with this id, unless it expired.
    pub fn get(&self, id: &str) -> Option<PendingDevice> {
        let pending = self.lock();
        let p = pending.get(id)?;
        (p.created.elapsed() < PENDING_TTL).then(|| p.clone())
    }

    /// Record the user's decision. Returns false when the id is unknown,
    /// expired or already decided (a link works once).
    pub fn decide(&self, id: &str, decision: Decision) -> bool {
        {
            let mut pending = self.lock();
            let Some(p) = pending.get_mut(id) else { return false };
            if p.created.elapsed() >= PENDING_TTL || p.decision != Decision::Pending {
                return false;
            }
            p.decision = decision;
        }
        self.changed.notify_waiters();
        true
    }

    /// Wait until the sign-in of `machine_key` with this id is decided, or the
    /// wait ends. A decided sign-in is consumed. `None` = unknown, expired, or
    /// the id belongs to another machine.
    pub async fn wait(&self, id: &str, machine_key: &[u8; 32], max_wait: Duration) -> Option<Decision> {
        let deadline = tokio::time::Instant::now() + max_wait;
        loop {
            let notified = self.changed.notified();
            {
                let mut pending = self.lock();
                let p = pending.get(id)?;
                if &p.machine_key != machine_key || p.created.elapsed() >= PENDING_TTL {
                    return None;
                }
                if p.decision != Decision::Pending {
                    return pending.remove(id).map(|p| p.decision);
                }
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return Some(Decision::Pending);
            }
        }
    }
}

/// The id at the end of a sign-in URL (`…/device/<id>`), if it looks like one.
pub fn id_from_url(url: &str) -> Option<&str> {
    let id = url.trim_end_matches('/').rsplit('/').next()?;
    (id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())).then_some(id)
}

/// Short fingerprint of a machine key, shown to the user on the approval page
/// and by `tailscale status`-style tools so they can compare.
pub fn fingerprint(machine_key: &[u8; 32]) -> String {
    let hex = hex::encode(&machine_key[..8]);
    format!("{}-{}-{}-{}", &hex[0..4], &hex[4..8], &hex[8..12], &hex[12..16])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn approve_wakes_the_waiting_device_once() {
        let reg = DeviceAuthRegistry::new();
        let id = reg.start([1; 32], "phone".into(), "iOS".into());
        let waiter = {
            let reg = reg.clone();
            let id = id.clone();
            tokio::spawn(async move { reg.wait(&id, &[1; 32], Duration::from_secs(5)).await })
        };
        tokio::task::yield_now().await;
        let tenant = TenantId::generate();
        assert!(reg.decide(&id, Decision::Approved { tenant_id: tenant, owner: "alice".into() }));
        assert_eq!(waiter.await.unwrap(), Some(Decision::Approved { tenant_id: tenant, owner: "alice".into() }));
        // Consumed: the link works once
        assert!(!reg.decide(&id, Decision::Denied));
        assert!(reg.get(&id).is_none());
    }

    #[tokio::test]
    async fn wait_times_out_as_pending_and_rejects_other_machines() {
        let reg = DeviceAuthRegistry::new();
        let id = reg.start([1; 32], "phone".into(), "iOS".into());
        assert_eq!(reg.wait(&id, &[1; 32], Duration::from_millis(20)).await, Some(Decision::Pending));
        assert_eq!(reg.wait(&id, &[2; 32], Duration::from_millis(20)).await, None, "another machine cannot claim the id");
        assert_eq!(reg.wait("00000000000000000000000000000000", &[1; 32], Duration::from_millis(20)).await, None);
    }

    #[test]
    fn a_machine_has_one_pending_sign_in_and_a_decision_is_final() {
        let reg = DeviceAuthRegistry::new();
        let first = reg.start([1; 32], "a".into(), "linux".into());
        let second = reg.start([1; 32], "a".into(), "linux".into());
        assert!(reg.get(&first).is_none());
        assert!(reg.get(&second).is_some());
        assert!(reg.decide(&second, Decision::Denied));
        assert!(!reg.decide(&second, Decision::Approved { tenant_id: TenantId::generate(), owner: "x".into() }));
    }

    #[test]
    fn ids_and_fingerprints() {
        assert_eq!(id_from_url("https://x.example/device/0123456789abcdef0123456789abcdef/"), Some("0123456789abcdef0123456789abcdef"));
        assert_eq!(id_from_url("https://x.example/device/nope"), None);
        assert_eq!(id_from_url("https://example.com/register"), None);
        assert_eq!(fingerprint(&[0xab; 32]), "abab-abab-abab-abab");
    }
}
