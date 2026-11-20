use std::collections::HashMap;
use std::sync::RwLock;

use coord_core::TenantId;
use coord_proto::map::UserProfile;

/// Fallback names when the TS service has not pushed identity for a tenant/owner.
pub const DEFAULT_DOMAIN: &str = "mesh.local";
pub const DEFAULT_LOGIN_NAME: &str = "mesh@coordinator.local";
pub const DEFAULT_DISPLAY_NAME: &str = "Mesh User";

/// Upper bounds on pushed identity (in-memory, admin-only input).
pub const MAX_IDENTITY_USERS: usize = 10_000;
pub const MAX_IDENTITY_TEXT: usize = 256;

/// How one owner (the TS service's user id) is shown to Tailscale clients.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct UserIdentity {
    /// e.g. the Bluesky handle `alice.bsky.social`.
    pub login_name: String,
    #[serde(default)]
    pub display_name: String,
}

/// Per-tenant names shown in Tailscale clients (in-memory; the TS service
/// pushes and replays it). `tailnet_name` becomes the netmap `Domain`, which
/// clients show as the tailnet / profile name.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TenantIdentity {
    #[serde(default)]
    pub tailnet_name: Option<String>,
    /// owner id -> identity
    #[serde(default)]
    pub users: std::collections::BTreeMap<String, UserIdentity>,
}

impl TenantIdentity {
    /// Rejects oversized input and strips control characters from names.
    pub fn sanitized(mut self) -> Result<Self, &'static str> {
        if self.users.len() > MAX_IDENTITY_USERS {
            return Err("too many users");
        }
        fn clean(s: &str) -> Result<String, &'static str> {
            if s.len() > MAX_IDENTITY_TEXT {
                return Err("name too long");
            }
            Ok(s.chars().filter(|c| !c.is_control()).collect::<String>().trim().to_string())
        }
        self.tailnet_name = match self.tailnet_name {
            Some(n) => Some(clean(&n)?).filter(|n| !n.is_empty()),
            None => None,
        };
        let mut users = std::collections::BTreeMap::new();
        for (owner, u) in self.users {
            if owner.is_empty() || owner.len() > MAX_IDENTITY_TEXT {
                return Err("invalid owner id");
            }
            let login_name = clean(&u.login_name)?;
            if login_name.is_empty() {
                return Err("login_name is required");
            }
            let display_name = clean(&u.display_name)?;
            users.insert(owner, UserIdentity { login_name, display_name });
        }
        self.users = users;
        Ok(self)
    }
}

/// Stable Tailscale user id for an owner. Unowned nodes share id 1 (the
/// legacy single user); owners hash to a positive id that never collides with 1.
pub fn user_id_for(owner: Option<&str>) -> i64 {
    let Some(owner) = owner else { return 1 };
    // FNV-1a 64, kept within JSON-safe integer range (53 bits).
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in owner.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    let id = (h & 0x001f_ffff_ffff_ffff) as i64;
    if id <= 1 { id + 2 } else { id }
}

#[derive(Default)]
pub struct IdentityRegistry {
    tenants: RwLock<HashMap<TenantId, TenantIdentity>>,
}

impl IdentityRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_tenant(&self, tenant: TenantId, cfg: TenantIdentity) {
        self.tenants.write().unwrap_or_else(|e| e.into_inner()).insert(tenant, cfg);
    }

    pub fn get_tenant(&self, tenant: TenantId) -> TenantIdentity {
        self.tenants
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(&tenant)
            .cloned()
            .unwrap_or_default()
    }

    pub fn remove_tenant(&self, tenant: TenantId) {
        self.tenants.write().unwrap_or_else(|e| e.into_inner()).remove(&tenant);
    }

    /// The netmap Domain (tailnet name) for a tenant.
    pub fn domain(&self, tenant: TenantId) -> String {
        self.get_tenant(tenant).tailnet_name.unwrap_or_else(|| DEFAULT_DOMAIN.to_string())
    }

    /// The Tailscale user profile for an owner of a tenant.
    pub fn profile(&self, tenant: TenantId, owner: Option<&str>) -> UserProfile {
        let id = user_id_for(owner);
        let known = owner.and_then(|o| self.get_tenant(tenant).users.get(o).cloned());
        match known {
            Some(u) => UserProfile {
                id,
                display_name: if u.display_name.is_empty() { u.login_name.clone() } else { u.display_name },
                login_name: u.login_name,
            },
            None => UserProfile {
                id,
                login_name: DEFAULT_LOGIN_NAME.into(),
                display_name: DEFAULT_DISPLAY_NAME.into(),
            },
        }
    }
}

#[cfg(test)]
mod identity_tests {
    use super::*;

    #[test]
    fn user_ids_are_stable_distinct_and_never_the_legacy_id() {
        assert_eq!(user_id_for(None), 1);
        let a = user_id_for(Some("u-alice"));
        assert_eq!(a, user_id_for(Some("u-alice")));
        assert_ne!(a, user_id_for(Some("u-bob")));
        for o in ["", "a", "b", "u-1", "00000000-0000-0000-0000-000000000000"] {
            let id = user_id_for(Some(o));
            assert!(id > 1 && id < (1i64 << 53), "{o} -> {id}");
        }
    }

    #[test]
    fn sanitized_strips_control_chars_and_blank_names() {
        let mut users = std::collections::BTreeMap::new();
        users.insert("u".into(), UserIdentity { login_name: " al\u{7}ice ".into(), display_name: "A\nB".into() });
        let id = TenantIdentity { tailnet_name: Some("  ".into()), users }.sanitized().unwrap();
        assert_eq!(id.tailnet_name, None);
        assert_eq!(id.users["u"].login_name, "alice");
        assert_eq!(id.users["u"].display_name, "AB");
    }

    #[test]
    fn unknown_owner_gets_placeholder_profile() {
        let reg = IdentityRegistry::new();
        let t = TenantId::new(uuid::Uuid::new_v4());
        let p = reg.profile(t, Some("nobody"));
        assert_eq!(p.login_name, DEFAULT_LOGIN_NAME);
        assert_eq!(reg.domain(t), DEFAULT_DOMAIN);
    }
}
