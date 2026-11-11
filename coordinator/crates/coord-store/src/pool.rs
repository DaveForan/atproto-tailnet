use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

use coord_core::StorageError;

pub async fn create_pool(database_url: &str) -> Result<PgPool, StorageError> {
    PgPoolOptions::new()
        .max_connections(20)
        .connect(database_url)
        .await
        .map_err(StorageError::new)
}
