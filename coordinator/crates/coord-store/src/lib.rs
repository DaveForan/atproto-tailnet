pub mod pool;
pub mod memory;
pub mod pg;
mod dispatch;

pub use pool::create_pool;
pub use memory::{MemoryStore, PeerEvent, TenantRouteSnapshot};
pub use pg::PgStore;
pub use dispatch::Store;

const PEER_EVENT_CHANNEL_CAPACITY: usize = 256;

pub(crate) fn generate_random_id() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 8];
    rand::rng().fill_bytes(&mut buf);
    hex::encode(buf)
}
