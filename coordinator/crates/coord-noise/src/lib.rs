pub mod handshake;
pub mod transport;

pub use handshake::{NoiseResponder, SplitKeys};
pub use transport::{NoiseTransport, spawn_noise_bridge};

pub fn generate_control_key() -> coord_core::ControlKey {
    use rand::RngCore;
    let mut secret = [0u8; 32];
    rand::rng().fill_bytes(&mut secret);
    let public = x25519_public_from_secret(&secret);
    coord_core::ControlKey::new(public, secret)
}

fn x25519_public_from_secret(secret: &[u8; 32]) -> [u8; 32] {
    use curve25519_dalek::montgomery::MontgomeryPoint;
    use curve25519_dalek::scalar::Scalar;
    let clamped = clamp_scalar(secret);
    let scalar = Scalar::from_bytes_mod_order(clamped);
    let point = MontgomeryPoint::mul_base(&scalar);
    point.to_bytes()
}

fn clamp_scalar(secret: &[u8; 32]) -> [u8; 32] {
    let mut clamped = *secret;
    clamped[0] &= 248;
    clamped[31] &= 127;
    clamped[31] |= 64;
    clamped
}
