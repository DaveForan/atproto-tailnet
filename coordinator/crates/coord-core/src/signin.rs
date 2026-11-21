//! Pending interactive device sign-ins (ADR-0032), kept in the store so that
//! every coordinator replica sees them (ADR-0034).

use serde::{Deserialize, Serialize};

use crate::TenantId;

/// How long a sign-in link stays valid.
pub const SIGN_IN_TTL_SECS: i64 = 10 * 60;
/// Pending sign-ins kept at once; new sign-ins are refused beyond this.
pub const MAX_PENDING_SIGN_INS: i64 = 10_000;
/// Pending sign-ins one client address can hold at once.
pub const MAX_PENDING_SIGN_INS_PER_IP: i64 = 20;

/// Caps on pending sign-ins. A full cap refuses new sign-ins and never evicts pending ones.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SignInLimits {
    pub per_ip: i64,
    pub total: i64,
}

impl Default for SignInLimits {
    fn default() -> Self {
        Self { per_ip: MAX_PENDING_SIGN_INS_PER_IP, total: MAX_PENDING_SIGN_INS }
    }
}

/// Result of an attempt to start a sign-in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignInStart {
    Started,
    /// The requester's address holds `SignInLimits::per_ip` pending sign-ins.
    TooManyFromAddress,
    /// The instance holds `SignInLimits::total` pending sign-ins.
    Full,
}

/// The user's answer to a sign-in. A sign-in without a decision is pending.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SignInDecision {
    Approved { tenant_id: TenantId, owner: String },
    Denied,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingSignIn {
    pub machine_key: [u8; 32],
    pub hostname: String,
    pub os: String,
    pub decision: Option<SignInDecision>,
    /// Client address of the request that started the sign-in (behind a
    /// trusted proxy, from X-Forwarded-For), when known.
    pub requester_ip: Option<String>,
    /// When the sign-in was started.
    pub requested_at: chrono::DateTime<chrono::Utc>,
}
