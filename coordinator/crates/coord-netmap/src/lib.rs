mod access;
mod caches;
mod dns;
mod registries;
mod service;

pub use access::{gateway_filter, member_view, service_rules, MemberView};
pub use caches::{TenantCaches, CONFIG_ACL, CONFIG_AUTO_APPROVERS, CONFIG_DERP, CONFIG_GATEWAY, CONFIG_IDENTITY};
pub use dns::{device_fqdn, dns_view, LEGACY_DEVICE_SUFFIX};
pub use registries::{
    user_id_for, AutoApproverRegistry, AutoApprovers, DerpRegistry, GatewayRegistry, IdentityRegistry, TenantDerp,
    TenantIdentity, UserIdentity, DEFAULT_DISPLAY_NAME, DEFAULT_DOMAIN, DEFAULT_LOGIN_NAME, MAX_IDENTITY_TEXT,
    MAX_IDENTITY_USERS,
};
pub use service::{home_region_for, NetmapService};
