use crate::MachineKey;

const MACHINE_KEY_PREFIX: &str = "mkey:";
const NODE_KEY_PREFIX: &str = "nodekey:";

pub fn encode_key_hex(prefix: &str, key: &[u8; 32]) -> String {
    format!("{}{}", prefix, hex::encode(key))
}

pub fn format_machine_key(key: &MachineKey) -> String {
    encode_key_hex(MACHINE_KEY_PREFIX, &key.0)
}

pub fn format_node_key(key: &[u8; 32]) -> String {
    encode_key_hex(NODE_KEY_PREFIX, key)
}

/// Parse a node key as Tailscale clients send it: `nodekey:` and 64 hex digits.
///
/// # Errors
/// A missing prefix, bad hex, or a length other than 32 bytes.
pub fn parse_node_key(s: &str) -> Result<[u8; 32], String> {
    let hex_part = s.strip_prefix(NODE_KEY_PREFIX).ok_or("node key must start with nodekey:")?;
    let bytes = hex::decode(hex_part).map_err(|e| format!("node key is not hex: {e}"))?;
    bytes.try_into().map_err(|b: Vec<u8>| format!("node key must be 32 bytes, got {}", b.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_keys_need_the_nodekey_prefix() {
        let hex = "ab".repeat(32);
        assert_eq!(parse_node_key(&format!("nodekey:{hex}")), Ok([0xab; 32]));
        assert_eq!(parse_node_key(&format_node_key(&[7; 32])), Ok([7; 32]));
        assert!(parse_node_key(&hex).is_err(), "bare hex");
        assert!(parse_node_key(&format!("mkey:{hex}")).is_err(), "machine key prefix");
        assert!(parse_node_key("nodekey:abcd").is_err(), "short");
        assert!(parse_node_key(&format!("nodekey:{}", "zz".repeat(32))).is_err(), "not hex");
    }
}
