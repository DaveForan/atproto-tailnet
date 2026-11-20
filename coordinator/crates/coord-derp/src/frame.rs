//! DERP framing: a 1-byte type and a 4-byte big-endian length, then the payload.

use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// `DERP🔑` — first bytes of the server-key frame.
pub const MAGIC: &[u8; 8] = b"DERP\xf0\x9f\x94\x91";
pub const PROTOCOL_VERSION: u32 = 2;
/// Largest relayed packet.
pub const MAX_PACKET_SIZE: usize = 64 << 10;
pub const KEY_LEN: usize = 32;
pub const NONCE_LEN: usize = 24;
pub const FRAME_HEADER_LEN: usize = 5;
/// Largest client-info frame accepted during the handshake.
pub const MAX_CLIENT_INFO_LEN: usize = 256 << 10;
/// Base interval between server keep-alive frames.
pub const KEEP_ALIVE: Duration = Duration::from_secs(60);

/// 8B magic + 32B server public key.
pub const FRAME_SERVER_KEY: u8 = 0x01;
/// 32B client public key + 24B nonce + naclbox(json).
pub const FRAME_CLIENT_INFO: u8 = 0x02;
/// 24B nonce + naclbox(json).
pub const FRAME_SERVER_INFO: u8 = 0x03;
/// 32B destination public key + packet.
pub const FRAME_SEND_PACKET: u8 = 0x04;
/// 32B source public key + packet.
pub const FRAME_RECV_PACKET: u8 = 0x05;
/// No payload.
pub const FRAME_KEEP_ALIVE: u8 = 0x06;
/// 1 byte: whether this is the client's home relay.
pub const FRAME_NOTE_PREFERRED: u8 = 0x07;
/// 32B public key of the peer that is gone + 1 byte reason.
pub const FRAME_PEER_GONE: u8 = 0x08;
/// 8 bytes, echoed back in a pong.
pub const FRAME_PING: u8 = 0x12;
/// 8 bytes: the ping payload being answered.
pub const FRAME_PONG: u8 = 0x13;

/// The peer was connected to this relay and disconnected.
pub const PEER_GONE_DISCONNECTED: u8 = 0x00;
/// This relay does not know the peer.
pub const PEER_GONE_NOT_HERE: u8 = 0x01;

/// Read one frame header: `(type, payload length)`.
pub async fn read_header<R: AsyncRead + Unpin>(r: &mut R) -> std::io::Result<(u8, u32)> {
    let mut hdr = [0u8; FRAME_HEADER_LEN];
    r.read_exact(&mut hdr).await?;
    Ok((hdr[0], u32::from_be_bytes([hdr[1], hdr[2], hdr[3], hdr[4]])))
}

/// Write one frame whose payload is the concatenation of `parts`. Does not flush.
pub async fn write_frame<W: AsyncWrite + Unpin>(w: &mut W, frame_type: u8, parts: &[&[u8]]) -> std::io::Result<()> {
    let len: usize = parts.iter().map(|p| p.len()).sum();
    let len = u32::try_from(len).map_err(|_| std::io::Error::other("frame too large"))?;
    let mut hdr = [0u8; FRAME_HEADER_LEN];
    hdr[0] = frame_type;
    hdr[1..].copy_from_slice(&len.to_be_bytes());
    w.write_all(&hdr).await?;
    for p in parts {
        w.write_all(p).await?;
    }
    Ok(())
}

/// Read and drop `len` payload bytes.
pub async fn discard<R: AsyncRead + Unpin>(r: &mut R, len: u32) -> std::io::Result<()> {
    let copied = tokio::io::copy(&mut r.take(u64::from(len)), &mut tokio::io::sink()).await?;
    if copied != u64::from(len) {
        return Err(std::io::ErrorKind::UnexpectedEof.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frame_round_trip() {
        let mut buf = Vec::new();
        write_frame(&mut buf, FRAME_SEND_PACKET, &[&[7u8; 32], b"hello"]).await.unwrap();
        assert_eq!(&buf[..5], &[FRAME_SEND_PACKET, 0, 0, 0, 37]);
        let mut r = &buf[..];
        let (ty, len) = read_header(&mut r).await.unwrap();
        assert_eq!((ty, len), (FRAME_SEND_PACKET, 37));
        assert_eq!(r.len(), 37);
    }

    #[tokio::test]
    async fn discard_consumes_exactly_the_payload() {
        let data = [1u8, 2, 3, 4, 5];
        let mut r = &data[..];
        discard(&mut r, 3).await.unwrap();
        assert_eq!(r, &[4, 5]);
        assert!(discard(&mut r, 9).await.is_err());
    }

    #[test]
    fn magic_is_derp_key_emoji() {
        assert_eq!(MAGIC, "DERP🔑".as_bytes());
    }
}
