//! Gateway node (ADR-0029): a server-side member of tailnets, built from
//! primitive crates only. No Tailscale code.

pub mod netstack;

pub mod tunnel;
pub mod proxy;

use blake2::digest::Mac;

/// A key of the gateway in one tailnet, derived from the gateway's secret.
/// The gateway then has the same keys after a restart and on every replica
/// that has the secret, and no key is kept in the database.
pub fn derive_key(secret: &[u8; 32], tenant: &[u8; 16], purpose: &str) -> [u8; 32] {
    let mut mac = <blake2::Blake2sMac256 as Mac>::new_from_slice(secret).expect("a 32-byte key is valid");
    mac.update(b"atproto-tailnet gateway v1\0");
    mac.update(purpose.as_bytes());
    mac.update(&[0]);
    mac.update(tenant);
    mac.finalize().into_bytes().into()
}

#[cfg(test)]
mod key_tests {
    use super::derive_key;

    #[test]
    fn keys_are_stable_and_differ_by_tenant_purpose_and_secret() {
        let base = derive_key(&[1; 32], &[2; 16], "node");
        assert_eq!(base, derive_key(&[1; 32], &[2; 16], "node"));
        assert_ne!(base, derive_key(&[1; 32], &[3; 16], "node"));
        assert_ne!(base, derive_key(&[1; 32], &[2; 16], "disco"));
        assert_ne!(base, derive_key(&[9; 32], &[2; 16], "node"));
    }
}
