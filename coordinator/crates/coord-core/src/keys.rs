use crate::MachineKey;

const MACHINE_KEY_PREFIX: &str = "mkey:";
const NODE_KEY_PREFIX: &str = "nodekey:";

pub fn encode_key_hex(prefix: &str, key: &[u8; 32]) -> String {
    format!("{}{}", prefix, hex::encode(key))
}

pub fn decode_key_hex(s: &str) -> Option<(String, [u8; 32])> {
    let (prefix, hex_part) = if let Some(rest) = s.strip_prefix(MACHINE_KEY_PREFIX) {
        (MACHINE_KEY_PREFIX.to_string(), rest)
    } else if let Some(rest) = s.strip_prefix(NODE_KEY_PREFIX) {
        (NODE_KEY_PREFIX.to_string(), rest)
    } else {
        return None;
    };

    let bytes = hex::decode(hex_part).ok()?;
    if bytes.len() != 32 {
        return None;
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    Some((prefix, key))
}

pub fn format_machine_key(key: &MachineKey) -> String {
    encode_key_hex(MACHINE_KEY_PREFIX, &key.0)
}

pub fn format_node_key(key: &[u8; 32]) -> String {
    encode_key_hex(NODE_KEY_PREFIX, key)
}

pub fn parse_node_key(s: &str) -> Option<[u8; 32]> {
    let hex_str = s.strip_prefix(NODE_KEY_PREFIX)?;
    let bytes = hex::decode(hex_str).ok()?;
    if bytes.len() != 32 {
        return None;
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    Some(key)
}
