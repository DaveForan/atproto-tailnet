use chacha20poly1305::{ChaCha20Poly1305, KeyInit, aead::Aead};
use chacha20poly1305::aead::generic_array::GenericArray;
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

/// Encrypting half of a Noise transport: one key and its nonce counter.
pub struct NoiseSender {
    cipher: ChaCha20Poly1305,
    nonce: u64,
}

impl NoiseSender {
    fn new(key: [u8; 32]) -> Self {
        Self { cipher: ChaCha20Poly1305::new(GenericArray::from_slice(&key)), nonce: 0 }
    }

    pub fn encrypt(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, NoiseError> {
        if plaintext.len() > MAX_PLAINTEXT_SIZE {
            return Err(NoiseError::Transport(format!(
                "plaintext {} exceeds max {}", plaintext.len(), MAX_PLAINTEXT_SIZE
            )));
        }
        if self.nonce == u64::MAX {
            return Err(NoiseError::Transport("tx nonce exhausted".into()));
        }
        let ciphertext = self
            .cipher
            .encrypt(GenericArray::from_slice(&make_nonce(self.nonce)), plaintext)
            .map_err(|e| NoiseError::Transport(format!("encrypt: {e}")))?;
        self.nonce += 1;
        Ok(ciphertext)
    }
}

/// Decrypting half of a Noise transport: one key and its nonce counter.
pub struct NoiseReceiver {
    cipher: ChaCha20Poly1305,
    nonce: u64,
}

impl NoiseReceiver {
    fn new(key: [u8; 32]) -> Self {
        Self { cipher: ChaCha20Poly1305::new(GenericArray::from_slice(&key)), nonce: 0 }
    }

    pub fn decrypt(&mut self, ciphertext: &[u8]) -> Result<Vec<u8>, NoiseError> {
        if self.nonce == u64::MAX {
            return Err(NoiseError::Transport("rx nonce exhausted".into()));
        }
        let plaintext = self
            .cipher
            .decrypt(GenericArray::from_slice(&make_nonce(self.nonce)), ciphertext)
            .map_err(|e| NoiseError::Transport(format!("decrypt: {e}")))?;
        self.nonce += 1;
        Ok(plaintext)
    }
}

/// Noise transport keys from the IK split, with Tailscale's big-endian nonces.
/// The halves are independent, so each direction can run in its own task.
pub struct NoiseTransport {
    pub sender: NoiseSender,
    pub receiver: NoiseReceiver,
}

impl NoiseTransport {
    /// `tx_key` encrypts what this side sends; `rx_key` decrypts what it receives.
    pub fn new(tx_key: [u8; 32], rx_key: [u8; 32]) -> Self {
        Self { sender: NoiseSender::new(tx_key), receiver: NoiseReceiver::new(rx_key) }
    }

    /// The server side: it receives with the initiator key and sends with the responder key.
    pub fn from_responder_keys(initiator_key: [u8; 32], responder_key: [u8; 32]) -> Self {
        Self::new(responder_key, initiator_key)
    }

    pub fn encrypt(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, NoiseError> {
        self.sender.encrypt(plaintext)
    }

    pub fn decrypt(&mut self, ciphertext: &[u8]) -> Result<Vec<u8>, NoiseError> {
        self.receiver.decrypt(ciphertext)
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

    let ct_len = usize::from(u16::from_be_bytes([hdr[1], hdr[2]]));
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
    let ct_len = u16::try_from(ciphertext.len())
        .ok()
        .filter(|&n| usize::from(n) <= MAX_CIPHERTEXT_SIZE)
        .ok_or_else(|| NoiseError::Protocol("ciphertext too large for frame".into()))?;
    let [hi, lo] = ct_len.to_be_bytes();
    writer.write_all(&[MSG_TYPE_RECORD, hi, lo]).await?;
    writer.write_all(ciphertext).await?;
    writer.flush().await?;
    Ok(())
}

/// Spawn two bridge tasks between the Noise-framed connection and a cleartext
/// duplex stream. Each task owns one half of the transport.
/// Returns the cleartext side for the HTTP/2 server.
pub fn spawn_noise_bridge<IO>(
    io: IO,
    transport: NoiseTransport,
) -> tokio::io::DuplexStream
where
    IO: AsyncRead + AsyncWrite + Send + Unpin + 'static,
{
    let (duplex_bridge, duplex_h2) = tokio::io::duplex(65536);
    let NoiseTransport { sender, receiver } = transport;

    let (tcp_read, tcp_write) = tokio::io::split(io);
    let (duplex_read, duplex_write) = tokio::io::split(duplex_bridge);

    // When one task ends, the other must end too. The split halves share an
    // Arc, so the duplex is not dropped and H2 would hang without this.
    let cancel = tokio_util::sync::CancellationToken::new();

    let cancel_in = cancel.clone();
    tokio::spawn(async move {
        let _guard = cancel_in.clone().drop_guard();
        if let Err(e) = bridge_inbound(tcp_read, duplex_write, receiver, cancel_in).await {
            tracing::debug!(error = %e, "noise bridge inbound ended");
        }
    });

    let cancel_out = cancel;
    tokio::spawn(async move {
        let _guard = cancel_out.clone().drop_guard();
        if let Err(e) = bridge_outbound(duplex_read, tcp_write, sender, cancel_out).await {
            tracing::debug!(error = %e, "noise bridge outbound ended");
        }
    });

    duplex_h2
}

/// TCP → decrypt → duplex.
async fn bridge_inbound<R, W>(
    mut tcp_read: R,
    mut duplex_write: W,
    mut receiver: NoiseReceiver,
    cancel: tokio_util::sync::CancellationToken,
) -> Result<(), NoiseError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    loop {
        let ciphertext = tokio::select! {
            () = cancel.cancelled() => return Ok(()),
            result = read_record_frame(&mut tcp_read) => match result {
                Ok(ct) => ct,
                Err(NoiseError::Io(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(()),
                Err(e) => return Err(e),
            },
        };
        let plaintext = receiver.decrypt(&ciphertext)?;
        duplex_write.write_all(&plaintext).await?;
        duplex_write.flush().await?;
    }
}

/// duplex → encrypt → TCP.
async fn bridge_outbound<R, W>(
    mut duplex_read: R,
    mut tcp_write: W,
    mut sender: NoiseSender,
    cancel: tokio_util::sync::CancellationToken,
) -> Result<(), NoiseError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; MAX_PLAINTEXT_SIZE];
    loop {
        let n = tokio::select! {
            () = cancel.cancelled() => return Ok(()),
            result = duplex_read.read(&mut buf) => result?,
        };
        if n == 0 {
            return Ok(());
        }
        let ciphertext = sender.encrypt(&buf[..n])?;
        write_record_frame(&mut tcp_write, &ciphertext).await?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_test_transport() -> (NoiseTransport, NoiseTransport) {
        let key_a = [1u8; 32];
        let key_b = [2u8; 32];
        let server = NoiseTransport::from_responder_keys(key_a, key_b);
        let client = NoiseTransport::new(key_a, key_b);
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
        assert_eq!(client.sender.nonce, 5);
        assert_eq!(server.receiver.nonce, 5);
    }

    #[test]
    fn decrypt_wrong_nonce_fails() {
        let (mut server, mut client) = make_test_transport();
        let ct = client.encrypt(b"msg1").unwrap();
        server.receiver.nonce = 99;
        assert!(server.decrypt(&ct).is_err());
    }

    #[test]
    fn decrypt_wrong_key_fails() {
        let (_, mut client) = make_test_transport();
        let ct = client.encrypt(b"data").unwrap();
        let mut wrong = NoiseTransport::from_responder_keys([3u8; 32], [4u8; 32]);
        assert!(wrong.decrypt(&ct).is_err());
    }

    #[tokio::test]
    async fn largest_record_fits_tailscale_frame_limit() {
        let (mut server, _) = make_test_transport();
        let ct = server.encrypt(&vec![0u8; MAX_PLAINTEXT_SIZE]).unwrap();
        let mut wire = Vec::new();
        write_record_frame(&mut wire, &ct).await.unwrap();
        assert_eq!(wire.len(), 4096, "Tailscale controlbase rejects frames over 4096 bytes");
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
    async fn bridge_halves_carry_both_directions_independently() {
        let (server, mut client) = make_test_transport();
        let (wire_server, mut wire_client) = tokio::io::duplex(65536);
        let mut clear = spawn_noise_bridge(wire_server, server);

        // Client → server
        for msg in [&b"one"[..], b"two"] {
            write_record_frame(&mut wire_client, &client.encrypt(msg).unwrap()).await.unwrap();
        }
        let mut got = [0u8; 6];
        clear.read_exact(&mut got).await.unwrap();
        assert_eq!(&got, b"onetwo");

        // Server → client
        clear.write_all(b"reply").await.unwrap();
        let ct = read_record_frame(&mut wire_client).await.unwrap();
        assert_eq!(client.decrypt(&ct).unwrap(), b"reply");

        // A forged record ends the bridge and closes the cleartext side
        write_record_frame(&mut wire_client, &[0u8; 32]).await.unwrap();
        let mut rest = Vec::new();
        assert_eq!(clear.read_to_end(&mut rest).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn write_record_frame_oversized_rejected() {
        let oversized = vec![0u8; MAX_CIPHERTEXT_SIZE + 1];
        let mut buf = Vec::new();
        assert!(write_record_frame(&mut buf, &oversized).await.is_err());
    }
}
