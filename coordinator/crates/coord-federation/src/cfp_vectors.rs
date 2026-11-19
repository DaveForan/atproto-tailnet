//! Cross-implementation CFP signing vectors (shared with the TypeScript
//! service's `src/__tests__/federation-cfp-vectors.test.ts`). Lives as a unit
//! test module so it runs with `cargo test -p coord-federation` without an
//! extra test binary.

use ed25519_dalek::SigningKey;
use serde_json::Value;

use crate::auth::{
    challenge_response_payload, message_signing_payload, route_origin_payload, signed_payload,
};
use crate::canonical::canonicalize;
use crate::protocol::{CfpMessage, CfpSigned};
use crate::signing::{
    JWS_PROTECTED_HEADER, sign_detached, verify_detached, verifying_key_from_jwk_x,
};

const FIXTURE: &str = include_str!("../tests/fixtures/cfp_vectors.json");

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("fixture parses")
}

fn signing_key(v: &Value) -> SigningKey {
    let seed = hex::decode(v["key"]["seedHex"].as_str().unwrap()).unwrap();
    SigningKey::from_bytes(&seed.try_into().unwrap())
}

fn struct_payload<T: CfpSigned>(m: &T) -> String {
    message_signing_payload(m).unwrap()
}

/// Signing payload rebuilt from the typed struct (what the Rust handshake signs).
fn typed_payload(message: &Value) -> String {
    match serde_json::from_value::<CfpMessage>(message.clone()).expect("message parses as CfpMessage") {
        CfpMessage::Hello(m) => struct_payload(&m),
        CfpMessage::Challenge(m) => struct_payload(&m),
        CfpMessage::Commit(m) => struct_payload(&m),
        CfpMessage::Established(m) => struct_payload(&m),
        CfpMessage::Keepalive(m) => struct_payload(&m),
        CfpMessage::RouteUpdate(m) => struct_payload(&m),
        CfpMessage::Revoke(m) => struct_payload(&m),
        CfpMessage::LinkRequest(m) => struct_payload(&m),
        CfpMessage::LinkAccept(m) => struct_payload(&m),
        CfpMessage::LinkReject(m) => struct_payload(&m),
        CfpMessage::LinkRevoke(m) => struct_payload(&m),
    }
}

#[test]
fn fixture_key_matches() {
    let v = fixture();
    assert_eq!(v["jwsProtectedHeader"], JWS_PROTECTED_HEADER);
    let key = signing_key(&v);
    assert_eq!(
        hex::encode(key.verifying_key().to_bytes()),
        v["key"]["publicKeyHex"].as_str().unwrap()
    );
    let from_jwk = verifying_key_from_jwk_x(v["key"]["publicKeyJwk"]["x"].as_str().unwrap()).unwrap();
    assert_eq!(from_jwk, key.verifying_key());
}

#[test]
fn jcs_vectors() {
    let v = fixture();
    for case in v["jcs"].as_array().unwrap() {
        let input: Value = serde_json::from_str(case["inputJson"].as_str().unwrap()).unwrap();
        assert_eq!(
            canonicalize(&input).unwrap(),
            case["canonical"].as_str().unwrap(),
            "JCS case {}",
            case["name"]
        );
    }
}

#[test]
fn message_vectors_sign_and_verify() {
    let v = fixture();
    let key = signing_key(&v);
    let vk = key.verifying_key();
    for m in v["messages"].as_array().unwrap() {
        let name = m["name"].as_str().unwrap();
        let expected_payload = m["signingPayload"].as_str().unwrap();
        let expected_sig = m["signature"].as_str().unwrap();
        let message = &m["message"];

        assert_eq!(signed_payload(message).unwrap(), expected_payload, "{name}: value payload");
        assert_eq!(typed_payload(message), expected_payload, "{name}: struct payload");
        assert_eq!(sign_detached(&key, expected_payload), expected_sig, "{name}: signature");
        assert!(verify_detached(&vk, expected_payload, expected_sig), "{name}: verify");
        assert_eq!(message["signature"].as_str().unwrap(), expected_sig);

        let mut tampered = message.clone();
        tampered["timestamp"] = Value::String("2026-11-19T12:00:01.000Z".into());
        assert!(
            !verify_detached(&vk, &signed_payload(&tampered).unwrap(), expected_sig),
            "{name}: tampered message must not verify"
        );
    }
}

#[test]
fn auxiliary_payload_vectors() {
    let v = fixture();
    let key = signing_key(&v);
    let messages = v["messages"].as_array().unwrap();
    let find = |n: &str| messages.iter().find(|m| m["name"] == n).unwrap()["message"].clone();
    let commit = find("commit");
    let challenge = find("challenge");
    for p in v["payloads"].as_array().unwrap() {
        let payload = p["payload"].as_str().unwrap();
        let rebuilt = match p["name"].as_str().unwrap() {
            "challenge-response" => challenge_response_payload(
                commit["challengeNonce"].as_str().unwrap(),
                commit["collectiveDid"].as_str().unwrap(),
                challenge["collectiveDid"].as_str().unwrap(),
            ),
            "route-origin" => route_origin_payload("100.64.1.0/24", v["key"]["did"].as_str().unwrap()),
            other => panic!("unknown payload vector {other}"),
        };
        assert_eq!(rebuilt, payload);
        assert_eq!(sign_detached(&key, payload), p["signature"].as_str().unwrap());
        assert!(verify_detached(&key.verifying_key(), payload, p["signature"].as_str().unwrap()));
    }
}
