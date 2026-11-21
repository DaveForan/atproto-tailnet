//! Interactive device sign-in (ADR-0032): a device without a key waits while a user approves it.
//! Pending sign-ins live in the store, so each step can reach another replica (ADR-0034).
//! This registry only wakes the waiting requests of this process.

use std::sync::Arc;
use std::time::Duration;

use coord_core::{PendingSignIn, SignInDecision, SignInLimits, SignInStart, TenantId};
use coord_store::{RemoteEvent, Store};
use rand::RngCore;
use tokio::sync::Notify;

/// Longest a device's follow-up request waits before it is told to ask again.
pub const FOLLOWUP_WAIT: Duration = Duration::from_secs(120);
/// A waiting request re-reads the store this often, in case another replica's notification was lost.
const RECHECK: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Pending,
    Approved { tenant_id: TenantId, owner: String },
    Denied,
}

impl From<SignInDecision> for Decision {
    fn from(d: SignInDecision) -> Self {
        match d {
            SignInDecision::Approved { tenant_id, owner } => Decision::Approved { tenant_id, owner },
            SignInDecision::Denied => Decision::Denied,
        }
    }
}

/// Why a sign-in could not start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartError {
    TooManyFromAddress,
    Full,
    Unavailable,
}

#[derive(Default)]
pub struct DeviceAuthRegistry {
    changed: Notify,
}

impl DeviceAuthRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Start a sign-in for a machine and return its id (128 random bits, hex).
    /// A new sign-in replaces the machine's pending one. A full cap refuses it.
    pub async fn start(
        &self,
        store: &Store,
        machine_key: [u8; 32],
        hostname: &str,
        os: &str,
        requester_ip: Option<std::net::IpAddr>,
        limits: SignInLimits,
    ) -> Result<String, StartError> {
        let mut id_bytes = [0u8; 16];
        rand::rng().fill_bytes(&mut id_bytes);
        let id = hex::encode(id_bytes);
        let ip = requester_ip.map(|ip| ip.to_string());
        match store.sign_in_start(&id, &machine_key, hostname, os, ip.as_deref(), limits).await {
            Ok(SignInStart::Started) => Ok(id),
            Ok(SignInStart::TooManyFromAddress) => {
                tracing::warn!(requester = ?requester_ip, "device sign-in refused: too many pending sign-ins from one address");
                Err(StartError::TooManyFromAddress)
            }
            Ok(SignInStart::Full) => {
                tracing::warn!("device sign-in refused: too many pending sign-ins");
                Err(StartError::Full)
            }
            Err(e) => {
                tracing::warn!(error = %e, "could not store a pending device sign-in");
                Err(StartError::Unavailable)
            }
        }
    }

    /// The sign-in with this id, unless it expired.
    pub async fn get(&self, store: &Store, id: &str) -> Option<PendingSignIn> {
        store.sign_in_get(id).await
    }

    /// Record the user's decision. Returns false when the id is unknown,
    /// expired or already decided (a link works once).
    pub async fn decide(&self, store: &Store, id: &str, decision: SignInDecision) -> bool {
        if !store.sign_in_decide(id, &decision).await {
            return false;
        }
        self.wake();
        store.publish(RemoteEvent::SignInDecided(id.to_string())).await;
        true
    }

    /// A sign-in was decided (here or on another replica): waiting requests look again.
    pub fn wake(&self) {
        self.changed.notify_waiters();
    }

    /// Waits until the sign-in is decided or the wait ends, and consumes a decided sign-in.
    /// `None` means unknown, expired, or owned by another machine.
    pub async fn wait(&self, store: &Store, id: &str, machine_key: &[u8; 32], max_wait: Duration) -> Option<Decision> {
        let deadline = tokio::time::Instant::now() + max_wait;
        loop {
            let notified = self.changed.notified();
            let p = store.sign_in_get(id).await?;
            if &p.machine_key != machine_key {
                return None;
            }
            if p.decision.is_some() {
                // One waiting request wins. A loser reports "unknown" and the device starts again.
                return store.sign_in_take(id).await.map(Decision::from);
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return Some(Decision::Pending);
            }
            let _ = tokio::time::timeout_at(deadline.min(now + RECHECK), notified).await;
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
    use coord_store::MemoryStore;

    fn store() -> Arc<Store> {
        Arc::new(Store::Memory(Box::new(MemoryStore::new())))
    }

    #[tokio::test]
    async fn approve_wakes_the_waiting_device_once() {
        let reg = DeviceAuthRegistry::new();
        let store = store();
        let id = reg.start(&store, [1; 32], "phone", "iOS", None, SignInLimits::default()).await.unwrap();
        let waiter = {
            let (reg, store, id) = (reg.clone(), store.clone(), id.clone());
            tokio::spawn(async move { reg.wait(&store, &id, &[1; 32], Duration::from_secs(5)).await })
        };
        tokio::task::yield_now().await;
        let tenant = TenantId::generate();
        let started = std::time::Instant::now();
        assert!(reg.decide(&store, &id, SignInDecision::Approved { tenant_id: tenant, owner: "alice".into() }).await);
        assert_eq!(waiter.await.unwrap(), Some(Decision::Approved { tenant_id: tenant, owner: "alice".into() }));
        assert!(started.elapsed() < RECHECK, "the waiter was woken, not polled");
        // Consumed: the link works once
        assert!(!reg.decide(&store, &id, SignInDecision::Denied).await);
        assert!(reg.get(&store, &id).await.is_none());
    }

    #[tokio::test]
    async fn wait_times_out_as_pending_and_rejects_other_machines() {
        let reg = DeviceAuthRegistry::new();
        let store = store();
        let id = reg.start(&store, [1; 32], "phone", "iOS", None, SignInLimits::default()).await.unwrap();
        assert_eq!(reg.wait(&store, &id, &[1; 32], Duration::from_millis(20)).await, Some(Decision::Pending));
        assert_eq!(reg.wait(&store, &id, &[2; 32], Duration::from_millis(20)).await, None, "another machine cannot claim the id");
        assert_eq!(reg.wait(&store, "00000000000000000000000000000000", &[1; 32], Duration::from_millis(20)).await, None);
    }

    #[tokio::test]
    async fn a_decision_made_without_a_wake_up_is_found_by_the_recheck() {
        // As if another replica decided and its notification was lost
        let reg = DeviceAuthRegistry::new();
        let store = store();
        let id = reg.start(&store, [1; 32], "phone", "iOS", None, SignInLimits::default()).await.unwrap();
        let waiter = {
            let (reg, store, id) = (reg.clone(), store.clone(), id.clone());
            tokio::spawn(async move { reg.wait(&store, &id, &[1; 32], Duration::from_secs(10)).await })
        };
        tokio::task::yield_now().await;
        assert!(store.sign_in_decide(&id, &SignInDecision::Denied).await);
        assert_eq!(waiter.await.unwrap(), Some(Decision::Denied));
    }

    #[tokio::test]
    async fn a_machine_has_one_pending_sign_in_and_a_decision_is_final() {
        let reg = DeviceAuthRegistry::new();
        let store = store();
        let first = reg.start(&store, [1; 32], "a", "linux", None, SignInLimits::default()).await.unwrap();
        let second = reg.start(&store, [1; 32], "a", "linux", None, SignInLimits::default()).await.unwrap();
        assert!(reg.get(&store, &first).await.is_none());
        assert!(reg.get(&store, &second).await.is_some());
        assert!(reg.decide(&store, &second, SignInDecision::Denied).await);
        assert!(!reg.decide(&store, &second, SignInDecision::Approved { tenant_id: TenantId::generate(), owner: "x".into() }).await);
    }

    #[tokio::test]
    async fn full_caps_refuse_new_sign_ins() {
        let reg = DeviceAuthRegistry::new();
        let store = store();
        let ip = Some("198.51.100.4".parse().unwrap());
        let limits = SignInLimits { per_ip: 1, total: 2 };
        let first = reg.start(&store, [1; 32], "a", "linux", ip, limits).await.unwrap();
        assert_eq!(reg.start(&store, [2; 32], "b", "linux", ip, limits).await, Err(StartError::TooManyFromAddress));
        reg.start(&store, [3; 32], "c", "linux", None, limits).await.unwrap();
        assert_eq!(reg.start(&store, [4; 32], "d", "linux", None, limits).await, Err(StartError::Full));
        assert!(reg.get(&store, &first).await.is_some(), "pending sign-ins are kept");
    }

    #[test]
    fn ids_and_fingerprints() {
        assert_eq!(id_from_url("https://x.example/device/0123456789abcdef0123456789abcdef/"), Some("0123456789abcdef0123456789abcdef"));
        assert_eq!(id_from_url("https://x.example/device/nope"), None);
        assert_eq!(id_from_url("https://example.com/register"), None);
        assert_eq!(fingerprint(&[0xab; 32]), "abab-abab-abab-abab");
    }
}
