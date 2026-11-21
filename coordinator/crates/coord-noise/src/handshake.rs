use snow::Builder;
use coord_core::ControlKey;

const NOISE_PATTERN: &str = "Noise_IK_25519_ChaChaPoly_BLAKE2s";
const PROLOGUE_PREFIX: &str = "Tailscale Control Protocol v";

pub const MSG_TYPE_INITIATION: u8 = 1;
pub const MSG_TYPE_RESPONSE: u8 = 2;
pub const MSG_TYPE_ERROR: u8 = 3;
pub const MSG_TYPE_RECORD: u8 = 4;

pub const INITIATION_HEADER_LEN: usize = 5;
pub const INITIATION_PAYLOAD_LEN: usize = 96;
pub const INITIATION_MESSAGE_LEN: usize = 101;

pub const RESPONSE_HEADER_LEN: usize = 3;
pub const RESPONSE_PAYLOAD_LEN: usize = 48;
pub const RESPONSE_MESSAGE_LEN: usize = 51;

pub const HEADER_LEN: usize = 3;
/// Matches Tailscale controlbase maxMessageSize; clients reject larger frames.
pub const MAX_MESSAGE_SIZE: usize = 4096;
pub const AEAD_OVERHEAD: usize = 16;
pub const MAX_CIPHERTEXT_SIZE: usize = MAX_MESSAGE_SIZE - HEADER_LEN;
pub const MAX_PLAINTEXT_SIZE: usize = MAX_CIPHERTEXT_SIZE - AEAD_OVERHEAD;

/// Raw symmetric keys from Noise Split().
/// initiator_key: encrypts initiator→responder (client→server).
/// responder_key: encrypts responder→initiator (server→client).
pub struct SplitKeys {
    pub initiator_key: [u8; 32],
    pub responder_key: [u8; 32],
}

pub struct NoiseResponder {
    control_key: ControlKey,
}

impl NoiseResponder {
    pub fn new(control_key: ControlKey) -> Self {
        Self { control_key }
    }

    pub fn control_public_key(&self) -> &[u8; 32] {
        &self.control_key.public
    }

    /// Accept a Tailscale wire-format initiation message (101 bytes).
    /// Returns (split_keys, wire-format response (51 bytes), machine_key, protocol_version).
    pub fn accept_initiation(
        &self,
        initiation: &[u8],
    ) -> Result<(SplitKeys, Vec<u8>, [u8; 32], u16), NoiseError> {
        if initiation.len() != INITIATION_MESSAGE_LEN {
            return Err(NoiseError::Handshake(format!(
                "initiation message is {} bytes, expected {}",
                initiation.len(),
                INITIATION_MESSAGE_LEN
            )));
        }

        let version = u16::from_be_bytes([initiation[0], initiation[1]]);
        let msg_type = initiation[2];
        if msg_type != MSG_TYPE_INITIATION {
            return Err(NoiseError::Handshake(format!(
                "expected initiation type 0x{:02x}, got 0x{:02x}",
                MSG_TYPE_INITIATION, msg_type
            )));
        }
        let payload_len = u16::from_be_bytes([initiation[3], initiation[4]]) as usize;
        if payload_len != INITIATION_PAYLOAD_LEN {
            return Err(NoiseError::Handshake(format!(
                "initiation payload length {}, expected {}",
                payload_len, INITIATION_PAYLOAD_LEN
            )));
        }

        let noise_payload = &initiation[INITIATION_HEADER_LEN..];
        let prologue = format!("{}{}", PROLOGUE_PREFIX, version);

        let (keys, resp_payload, machine_key) =
            self.accept_noise_payload(noise_payload, prologue.as_bytes())?;

        let mut response = Vec::with_capacity(RESPONSE_MESSAGE_LEN);
        response.push(MSG_TYPE_RESPONSE);
        let resp_len = resp_payload.len() as u16;
        response.push((resp_len >> 8) as u8);
        response.push(resp_len as u8);
        response.extend_from_slice(&resp_payload);

        Ok((keys, response, machine_key, version))
    }

    /// Accept raw Noise IK payload (96 bytes) — for snow-to-snow testing.
    pub fn accept_raw(
        &self,
        noise_payload: &[u8],
        protocol_version: u16,
    ) -> Result<(SplitKeys, Vec<u8>, [u8; 32]), NoiseError> {
        let prologue = format!("{}{}", PROLOGUE_PREFIX, protocol_version);
        self.accept_noise_payload(noise_payload, prologue.as_bytes())
    }

    fn accept_noise_payload(
        &self,
        noise_payload: &[u8],
        prologue: &[u8],
    ) -> Result<(SplitKeys, Vec<u8>, [u8; 32]), NoiseError> {
        let mut responder = Builder::new(
            NOISE_PATTERN
                .parse()
                .map_err(|e| NoiseError::Pattern(format!("{e}")))?,
        )
        .local_private_key(self.control_key.secret())
        .map_err(|e| NoiseError::Init(format!("{e}")))?
        .prologue(prologue)
        .map_err(|e| NoiseError::Init(format!("{e}")))?
        .build_responder()
        .map_err(|e| NoiseError::Init(format!("{e}")))?;

        let mut buf = vec![0u8; 65535];
        let _len = responder
            .read_message(noise_payload, &mut buf)
            .map_err(|e| NoiseError::Handshake(format!("read e,es,s,ss: {e}")))?;

        let remote_static = responder
            .get_remote_static()
            .ok_or_else(|| NoiseError::Handshake("no remote static key after IK message".into()))?;

        let mut machine_key = [0u8; 32];
        machine_key.copy_from_slice(remote_static);

        let response_len = responder
            .write_message(&[], &mut buf)
            .map_err(|e| NoiseError::Handshake(format!("write e,ee,se: {e}")))?;

        let (initiator_key, responder_key) = responder.dangerously_get_raw_split();

        let keys = SplitKeys { initiator_key, responder_key };

        Ok((keys, buf[..response_len].to_vec(), machine_key))
    }
}

#[derive(Debug, thiserror::Error)]
pub enum NoiseError {
    #[error("noise pattern error: {0}")]
    Pattern(String),

    #[error("noise init error: {0}")]
    Init(String),

    #[error("noise handshake error: {0}")]
    Handshake(String),

    #[error("noise transport error: {0}")]
    Transport(String),

    #[error("noise protocol error: {0}")]
    Protocol(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

#[cfg(test)]
mod tests {
    use super::*;
    use snow::Builder;

    #[test]
    fn noise_ik_handshake_roundtrip() {
        let control_key = crate::generate_control_key();
        let responder = NoiseResponder::new(control_key.clone());

        let prologue = format!("{}2", PROLOGUE_PREFIX);

        let mut initiator = Builder::new(NOISE_PATTERN.parse().unwrap())
            .local_private_key(&[1u8; 32])
            .unwrap()
            .remote_public_key(&control_key.public)
            .unwrap()
            .prologue(prologue.as_bytes())
            .unwrap()
            .build_initiator()
            .unwrap();

        let mut msg1 = vec![0u8; 65535];
        let len1 = initiator.write_message(&[], &mut msg1).unwrap();

        let (keys, response, machine_key) =
            responder.accept_raw(&msg1[..len1], 2).unwrap();

        let _len2 = initiator.read_message(&response, &mut msg1).unwrap();
        let _initiator_transport = initiator.into_transport_mode().unwrap();

        assert_ne!(machine_key, [0u8; 32]);
        assert_ne!(keys.initiator_key, [0u8; 32]);
        assert_ne!(keys.responder_key, [0u8; 32]);
    }

    #[test]
    fn accept_initiation_wire_format() {
        let control_key = crate::generate_control_key();
        let responder = NoiseResponder::new(control_key.clone());

        let prologue = format!("{}1", PROLOGUE_PREFIX);

        let mut initiator = Builder::new(NOISE_PATTERN.parse().unwrap())
            .local_private_key(&[5u8; 32])
            .unwrap()
            .remote_public_key(&control_key.public)
            .unwrap()
            .prologue(prologue.as_bytes())
            .unwrap()
            .build_initiator()
            .unwrap();

        let mut noise_payload = vec![0u8; 65535];
        let payload_len = initiator.write_message(&[], &mut noise_payload).unwrap();
        assert_eq!(payload_len, INITIATION_PAYLOAD_LEN);

        let mut initiation = Vec::with_capacity(INITIATION_MESSAGE_LEN);
        initiation.extend_from_slice(&1u16.to_be_bytes());
        initiation.push(MSG_TYPE_INITIATION);
        initiation.extend_from_slice(&(payload_len as u16).to_be_bytes());
        initiation.extend_from_slice(&noise_payload[..payload_len]);
        assert_eq!(initiation.len(), INITIATION_MESSAGE_LEN);

        let (keys, response, machine_key, version) =
            responder.accept_initiation(&initiation).unwrap();

        assert_eq!(version, 1);
        assert_eq!(response.len(), RESPONSE_MESSAGE_LEN);
        assert_eq!(response[0], MSG_TYPE_RESPONSE);
        assert_ne!(machine_key, [0u8; 32]);
        assert_ne!(keys.initiator_key, [0u8; 32]);

        let resp_payload = &response[RESPONSE_HEADER_LEN..];
        let mut buf = vec![0u8; 65535];
        initiator.read_message(resp_payload, &mut buf).unwrap();
        let _initiator_transport = initiator.into_transport_mode().unwrap();
    }

    /// A valid wire-format initiation from a client that uses `version` in its prologue.
    fn initiation(control_public: &[u8; 32], version: u16) -> Vec<u8> {
        let prologue = format!("{PROLOGUE_PREFIX}{version}");
        let mut initiator = Builder::new(NOISE_PATTERN.parse().unwrap())
            .local_private_key(&[9u8; 32])
            .unwrap()
            .remote_public_key(control_public)
            .unwrap()
            .prologue(prologue.as_bytes())
            .unwrap()
            .build_initiator()
            .unwrap();
        let mut payload = vec![0u8; 256];
        let len = initiator.write_message(&[], &mut payload).unwrap();
        let mut msg = version.to_be_bytes().to_vec();
        msg.push(MSG_TYPE_INITIATION);
        msg.extend_from_slice(&u16::try_from(len).unwrap().to_be_bytes());
        msg.extend_from_slice(&payload[..len]);
        msg
    }

    #[test]
    fn a_version_that_differs_from_the_prologue_fails_the_handshake() {
        let key = crate::generate_control_key();
        let responder = NoiseResponder::new(key.clone());
        let mut msg = initiation(&key.public, 1);
        assert!(responder.accept_initiation(&msg).is_ok());
        msg[0..2].copy_from_slice(&3u16.to_be_bytes());
        assert!(matches!(responder.accept_initiation(&msg), Err(NoiseError::Handshake(_))));
    }

    #[test]
    fn truncated_and_padded_initiations_are_refused() {
        let key = crate::generate_control_key();
        let responder = NoiseResponder::new(key.clone());
        let msg = initiation(&key.public, 1);
        for len in [0, 2, INITIATION_HEADER_LEN, INITIATION_MESSAGE_LEN - 1] {
            assert!(responder.accept_initiation(&msg[..len]).is_err(), "length {len}");
        }
        let mut padded = msg.clone();
        padded.push(0);
        assert!(responder.accept_initiation(&padded).is_err());
    }

    #[test]
    fn wrong_message_type_payload_length_or_key_is_refused() {
        let key = crate::generate_control_key();
        let responder = NoiseResponder::new(key.clone());
        let msg = initiation(&key.public, 1);
        for wrong_type in [MSG_TYPE_RESPONSE, MSG_TYPE_ERROR, MSG_TYPE_RECORD, 0] {
            let mut m = msg.clone();
            m[2] = wrong_type;
            assert!(responder.accept_initiation(&m).is_err(), "type {wrong_type}");
        }
        let mut m = msg.clone();
        m[3..5].copy_from_slice(&95u16.to_be_bytes());
        assert!(responder.accept_initiation(&m).is_err(), "payload length");
        // Encrypted to another server key
        let other = crate::generate_control_key();
        assert!(responder.accept_initiation(&initiation(&other.public, 1)).is_err());
        // A flipped ciphertext byte fails authentication
        let mut m = msg;
        m[INITIATION_MESSAGE_LEN - 1] ^= 1;
        assert!(responder.accept_initiation(&m).is_err());
    }
}
