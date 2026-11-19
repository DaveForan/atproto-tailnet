pub mod pool;
pub mod memory;
pub mod pg;
pub mod sqlite;
mod dispatch;

pub use pool::{create_pool, create_sqlite_pool};
pub use memory::{MemoryStore, PeerEvent, TenantRouteSnapshot};
pub use pg::PgStore;
pub use sqlite::SqliteStore;
pub use dispatch::Store;

const PEER_EVENT_CHANNEL_CAPACITY: usize = 256;

/// Pre-auth keys are bearer credentials, so they get 256 bits of entropy.
pub(crate) fn generate_auth_key() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 32];
    rand::rng().fill_bytes(&mut buf);
    format!("tskey-auth-{}", hex::encode(buf))
}

pub(crate) fn generate_random_id() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 8];
    rand::rng().fill_bytes(&mut buf);
    hex::encode(buf)
}
