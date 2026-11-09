use chacha20poly1305::{ChaCha20Poly1305, KeyInit, aead::Aead};
use chacha20poly1305::aead::generic_array::GenericArray;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::handshake::{
    HEADER_LEN, MAX_CIPHERTEXT_SIZE, MAX_PLAINTEXT_SIZE, MSG_TYPE_RECORD,
    NoiseError,
};

/// Tailscale-compatible nonce: 4 zero bytes + 8-byte big-endian counter.
/// Go's controlbase uses this layout, which differs from snow's LE encoding.
fn make_nonce(counter: u64) -> [u8; 12] {
    let mut nonce = [0u8; 12];
    nonce[4..12].copy_from_slice(&counter.to_be_bytes());
    nonce
}

/// Encrypt/decrypt using chacha20poly1305 with Tailscale-compatible
/// big-endian nonce encoding. After Noise IK handshake, the two split
/// keys are used directly instead of snow's TransportState.
pub struct NoiseTransport {
    tx_cipher: ChaCha20Poly1305,
    rx_cipher: ChaCha20Poly1305,
    tx_nonce: u64,
    rx_nonce: u64,
}

impl NoiseTransport {
    /// Create from raw split keys. For the responder (server):
    /// - initiator_key (key0): client→server, used to decrypt (rx)
    /// - responder_key (key1): server→client, used to encrypt (tx)
    pub fn from_responder_keys(initiator_key: [u8; 32], responder_key: [u8; 32]) -> Self {
        Self {
            tx_cipher: ChaCha20Poly1305::new(GenericArray::from_slice(&responder_key)),
            rx_cipher: ChaCha20Poly1305::new(GenericArray::from_slice(&initiator_key)),
            tx_nonce: 0,
            rx_nonce: 0,
        }
    }

    pub fn encrypt(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, NoiseError> {
        if plaintext.len() > MAX_PLAINTEXT_SIZE {
            return Err(NoiseError::Transport(format!(
                "plaintext {} exceeds max {}", plaintext.len(), MAX_PLAINTEXT_SIZE
            )));
        }
        if self.tx_nonce == u64::MAX {
            return Err(NoiseError::Transport("tx nonce exhausted".into()));
        }
        let nonce = make_nonce(self.tx_nonce);
        let ciphertext = self
            .tx_cipher
            .encrypt(GenericArray::from_slice(&nonce), plaintext)
            .map_err(|e| NoiseError::Transport(format!("encrypt: {e}")))?;
        self.tx_nonce += 1;
        Ok(ciphertext)
    }

    pub fn decrypt(&mut self, ciphertext: &[u8]) -> Result<Vec<u8>, NoiseError> {
        if self.rx_nonce == u64::MAX {
            return Err(NoiseError::Transport("rx nonce exhausted".into()));
        }
        let nonce = make_nonce(self.rx_nonce);
        let plaintext = self
            .rx_cipher
            .decrypt(GenericArray::from_slice(&nonce), ciphertext)
            .map_err(|e| NoiseError::Transport(format!("decrypt: {e}")))?;
        self.rx_nonce += 1;
        Ok(plaintext)
    }
}

/// Read a single record frame from the wire.
/// Returns the ciphertext payload (without the 3-byte header).
pub async fn read_record_frame<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> Result<Vec<u8>, NoiseError> {
    let mut hdr = [0u8; HEADER_LEN];
    reader.read_exact(&mut hdr).await?;

    let frame_type = hdr[0];
    if frame_type != MSG_TYPE_RECORD {
        return Err(NoiseError::Protocol(format!(
            "expected record frame type 0x{:02x}, got 0x{:02x}",
            MSG_TYPE_RECORD, frame_type
        )));
    }

    let ct_len = u16::from_be_bytes([hdr[1], hdr[2]]) as usize;
    if ct_len > MAX_CIPHERTEXT_SIZE {
        return Err(NoiseError::Protocol(format!(
            "record frame ciphertext {} exceeds max {}",
            ct_len, MAX_CIPHERTEXT_SIZE
        )));
    }

    let mut payload = vec![0u8; ct_len];
    reader.read_exact(&mut payload).await?;
    Ok(payload)
}

/// Write a single record frame to the wire.
pub async fn write_record_frame<W: AsyncWrite + Unpin>(
    writer: &mut W,
    ciphertext: &[u8],
) -> Result<(), NoiseError> {
    let ct_len = ciphertext.len();
    if ct_len > MAX_CIPHERTEXT_SIZE {
        return Err(NoiseError::Protocol("ciphertext too large for frame".into()));
    }

    let hdr = [
        MSG_TYPE_RECORD,
        (ct_len >> 8) as u8,
        ct_len as u8,
    ];
    writer.write_all(&hdr).await?;
    writer.write_all(ciphertext).await?;
    writer.flush().await?;
    Ok(())
}

/// Spawn two bridge tasks that shuttle data between the raw TCP connection
/// (with Noise record framing) and a duplex stream (cleartext for HTTP/2).
///
/// Returns the cleartext side of the duplex for the HTTP/2 server to use.
pub fn spawn_noise_bridge<IO>(
    io: IO,
    transport: NoiseTransport,
) -> tokio::io::DuplexStream
where
    IO: AsyncRead + AsyncWrite + Send + Unpin + 'static,
{
    let (duplex_bridge, duplex_h2) = tokio::io::duplex(65536);
    let transport = Arc::new(Mutex::new(transport));

    let (tcp_read, tcp_write) = tokio::io::split(io);
    let (duplex_read, duplex_write) = tokio::io::split(duplex_bridge);

    // When either bridge task exits, cancel the token so the other
    // shuts down too. Without this, tokio::io::split's Arc prevents
    // the DuplexStream from being dropped, so the surviving task and
    // the H2 connection hang forever.
    let cancel = tokio_util::sync::CancellationToken::new();

    let tr = transport.clone();
    let cancel_in = cancel.clone();
    tokio::spawn(async move {
        let _guard = cancel_in.clone().drop_guard();
        if let Err(e) = bridge_inbound(tcp_read, duplex_write, tr, cancel_in).await {
            tracing::debug!(error = %e, "noise bridge inbound ended");
        }
    });

    let tw = transport;
    let cancel_out = cancel;
    tokio::spawn(async move {
        let _guard = cancel_out.clone().drop_guard();
        if let Err(e) = bridge_outbound(duplex_read, tcp_write, tw, cancel_out).await {
            tracing::debug!(error = %e, "noise bridge outbound ended");
        }
    });

    duplex_h2
}

/// TCP → decrypt → duplex (server reads client data)
async fn bridge_inbound<R, W>(
    mut tcp_read: R,
    mut duplex_write: W,
    transport: Arc<Mutex<NoiseTransport>>,
    cancel: tokio_util::sync::CancellationToken,
) -> Result<(), NoiseError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut frame_count = 0u64;
    loop {
        let ciphertext = tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            result = read_record_frame(&mut tcp_read) => {
                match result {
                    Ok(ct) => ct,
                    Err(NoiseError::Io(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                        tracing::debug!(frames = frame_count, "noise bridge inbound: EOF");
                        return Ok(());
                    }
                    Err(e) => return Err(e),
                }
            }
        };

        tracing::debug!(
            frame = frame_count,
            ct_len = ciphertext.len(),
            "noise bridge inbound: read record frame"
        );

        let plaintext = {
            let mut t = transport.lock().unwrap_or_else(|e| e.into_inner());
            t.decrypt(&ciphertext)?
        };

        tracing::debug!(
            frame = frame_count,
            pt_len = plaintext.len(),
            "noise bridge inbound: decrypted"
        );

        duplex_write.write_all(&plaintext).await?;
        duplex_write.flush().await?;
        frame_count += 1;
    }
}

/// duplex → encrypt → TCP (server sends data to client)
async fn bridge_outbound<R, W>(
    mut duplex_read: R,
    mut tcp_write: W,
    transport: Arc<Mutex<NoiseTransport>>,
    cancel: tokio_util::sync::CancellationToken,
) -> Result<(), NoiseError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; MAX_PLAINTEXT_SIZE];
    let mut frame_count = 0u64;
    loop {
        let n = tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            result = duplex_read.read(&mut buf) => result?,
        };
        if n == 0 {
            tracing::debug!(frames = frame_count, "noise bridge outbound: duplex closed");
            return Ok(());
        }

        tracing::debug!(
            frame = frame_count,
            pt_len = n,
            "noise bridge outbound: encrypting"
        );

        let ciphertext = {
            let mut t = transport.lock().unwrap_or_else(|e| e.into_inner());
            t.encrypt(&buf[..n])?
        };

        tracing::debug!(
            frame = frame_count,
            ct_len = ciphertext.len(),
            "noise bridge outbound: writing record frame"
        );

        write_record_frame(&mut tcp_write, &ciphertext).await?;
        frame_count += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_test_transport() -> (NoiseTransport, NoiseTransport) {
        let key_a = [1u8; 32];
        let key_b = [2u8; 32];
        let server = NoiseTransport::from_responder_keys(key_a, key_b);
        let client = NoiseTransport {
            tx_cipher: ChaCha20Poly1305::new(GenericArray::from_slice(&key_a)),
            rx_cipher: ChaCha20Poly1305::new(GenericArray::from_slice(&key_b)),
            tx_nonce: 0,
            rx_nonce: 0,
        };
        (server, client)
    }

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let (mut server, mut client) = make_test_transport();
        let plaintext = b"hello from client";
        let ct = client.encrypt(plaintext).unwrap();
        assert_ne!(&ct, plaintext);
        let pt = server.decrypt(&ct).unwrap();
        assert_eq!(pt, plaintext);
    }

    #[test]
    fn server_to_client_roundtrip() {
        let (mut server, mut client) = make_test_transport();
        let plaintext = b"hello from server";
        let ct = server.encrypt(plaintext).unwrap();
        let pt = client.decrypt(&ct).unwrap();
        assert_eq!(pt, plaintext);
    }

    #[test]
    fn nonce_increments_correctly() {
        let (mut server, mut client) = make_test_transport();
        for i in 0..5u8 {
            let ct = client.encrypt(&[i]).unwrap();
            let pt = server.decrypt(&ct).unwrap();
            assert_eq!(pt, vec![i]);
        }
        assert_eq!(client.tx_nonce, 5);
        assert_eq!(server.rx_nonce, 5);
    }

    #[test]
    fn decrypt_wrong_nonce_fails() {
        let (mut server, mut client) = make_test_transport();
        let ct = client.encrypt(b"msg1").unwrap();
        server.rx_nonce = 99;
        assert!(server.decrypt(&ct).is_err());
    }

    #[test]
    fn decrypt_wrong_key_fails() {
        let (_, mut client) = make_test_transport();
        let ct = client.encrypt(b"data").unwrap();
        let wrong = NoiseTransport::from_responder_keys([3u8; 32], [4u8; 32]);
        let mut wrong_rx = NoiseTransport {
            tx_cipher: wrong.tx_cipher,
            rx_cipher: wrong.rx_cipher,
            tx_nonce: 0,
            rx_nonce: 0,
        };
        assert!(wrong_rx.decrypt(&ct).is_err());
    }

    #[test]
    fn plaintext_too_large_rejected() {
        let (_, mut client) = make_test_transport();
        let big = vec![0u8; MAX_PLAINTEXT_SIZE + 1];
        assert!(client.encrypt(&big).is_err());
    }

    #[tokio::test]
    async fn record_frame_roundtrip() {
        let data = b"some ciphertext bytes";
        let mut buf = Vec::new();
        write_record_frame(&mut buf, data).await.unwrap();
        let mut cursor = std::io::Cursor::new(buf);
        let read_back = read_record_frame(&mut cursor).await.unwrap();
        assert_eq!(read_back, data);
    }

    #[tokio::test]
    async fn record_frame_wrong_type_rejected() {
        let mut frame = vec![0xFF, 0x00, 0x03]; // wrong type byte
        frame.extend_from_slice(b"abc");
        let mut cursor = std::io::Cursor::new(frame);
        assert!(read_record_frame(&mut cursor).await.is_err());
    }

    #[tokio::test]
    async fn write_record_frame_oversized_rejected() {
        let oversized = vec![0u8; MAX_CIPHERTEXT_SIZE + 1];
        let mut buf = Vec::new();
        assert!(write_record_frame(&mut buf, &oversized).await.is_err());
    }
}
