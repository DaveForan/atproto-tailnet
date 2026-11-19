//! Detached-JWS EdDSA signatures over CFP signing payloads, byte-compatible
//! with the TypeScript service (`src/identity/keys.ts` `signDetached` /
//! `verifyDetached`): the signature is the base64url Ed25519 signature over
//! `base64url({"alg":"EdDSA"}) "." base64url(payload)`.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};

/// Protected header of every detached signature.
pub const JWS_PROTECTED_HEADER: &str = r#"{"alg":"EdDSA"}"#;

/// The JWS signing input for `payload`.
pub fn jws_signing_input(payload: &str) -> String {
    format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(JWS_PROTECTED_HEADER),
        URL_SAFE_NO_PAD.encode(payload)
    )
}

/// Sign `payload` with an Ed25519 key; returns the base64url signature.
pub fn sign_detached(key: &SigningKey, payload: &str) -> String {
    URL_SAFE_NO_PAD.encode(key.sign(jws_signing_input(payload).as_bytes()).to_bytes())
}

/// Verify a detached signature by `key` over `payload`. Never panics.
/// Uses strict verification (rejects small-order keys / malleable encodings).
pub fn verify_detached(key: &VerifyingKey, payload: &str, signature: &str) -> bool {
    let Ok(bytes) = URL_SAFE_NO_PAD.decode(signature) else {
        return false;
    };
    let Ok(sig) = Signature::from_slice(&bytes) else {
        return false;
    };
    key.verify_strict(jws_signing_input(payload).as_bytes(), &sig)
        .is_ok()
}

/// Parse an Ed25519 public key from an OKP JWK `x` member (base64url, 32 bytes).
pub fn verifying_key_from_jwk_x(x: &str) -> Option<VerifyingKey> {
    let bytes = URL_SAFE_NO_PAD.decode(x).ok()?;
    let arr: [u8; 32] = bytes.try_into().ok()?;
    VerifyingKey::from_bytes(&arr).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_tamper() {
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let sig = sign_detached(&key, "{\"a\":1}");
        assert!(verify_detached(&key.verifying_key(), "{\"a\":1}", &sig));
        assert!(!verify_detached(&key.verifying_key(), "{\"a\":2}", &sig));
        assert!(!verify_detached(&key.verifying_key(), "{\"a\":1}", "not-base64!"));
        assert!(!verify_detached(&key.verifying_key(), "{\"a\":1}", ""));
    }
}
