//! In-memory per-tenant registries that cache tenant configuration from the store (ADR-0034).

mod auto_approvers;
mod derp;
mod gateway;
mod identity;

pub use auto_approvers::{AutoApproverRegistry, AutoApprovers};
pub use derp::{DerpRegistry, TenantDerp};
pub use gateway::GatewayRegistry;
pub use identity::{
    user_id_for, IdentityRegistry, TenantIdentity, UserIdentity, DEFAULT_DISPLAY_NAME, DEFAULT_DOMAIN,
    DEFAULT_LOGIN_NAME, MAX_IDENTITY_TEXT, MAX_IDENTITY_USERS,
};
