use std::net::SocketAddr;
use std::sync::Arc;
use serde::Deserialize;
use tracing_subscriber::EnvFilter;

#[derive(Debug, Deserialize)]
#[serde(default)]
struct Config {
    listen: String,
    domain: String,
    derp_map_file: Option<String>,
    database_url: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            listen: "127.0.0.1:9443".into(),
            domain: "mesh.local".into(),
            derp_map_file: None,
            database_url: None,
        }
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("coordinator=info".parse()?))
        .json()
        .init();

    let config_path = std::env::args().nth(1);
    let config: Config = match &config_path {
        Some(path) => {
            let contents = std::fs::read_to_string(path)?;
            toml::from_str(&contents)?
        }
        None => Config::default(),
    };

    // Env vars override config file
    let listen_addr: SocketAddr = std::env::var("COORD_LISTEN")
        .unwrap_or(config.listen)
        .parse()?;

    let control_key = coord_core::ControlKey::generate();
    tracing::info!(
        control_public_key = hex::encode(control_key.public),
        "coordinator starting"
    );

    let mut coordinator = coord_api::CoordinatorState::new(control_key);

    let derp_path = std::env::var("COORD_DERP_MAP")
        .ok()
        .or(config.derp_map_file);

    if let Some(path) = derp_path {
        let contents = std::fs::read_to_string(&path)?;
        let derp_map: coord_proto::map::DerpMap = serde_json::from_str(&contents)?;
        tracing::info!(
            path = %path,
            regions = derp_map.regions.len(),
            "loaded custom DERP map"
        );
        coordinator = coordinator.with_derp_map(derp_map);
    }

    let database_url = std::env::var("DATABASE_URL")
        .ok()
        .or(config.database_url);

    if let Some(url) = &database_url {
        let pool = coord_store::create_pool(url).await?;
        let pg_store = coord_store::PgStore::new(pool.clone()).await?;
        tracing::info!("PostgreSQL store initialized, migrations applied");
        coordinator = coordinator.with_store(coord_store::Store::Pg(pg_store));

        let fed_store = std::sync::Arc::new(
            coord_federation::PgFederationStore::new(pool),
        );
        coordinator = coordinator.with_federation_store(fed_store);
        tracing::info!("federation store: PostgreSQL");
    }

    let admin_key = std::env::var("COORD_ADMIN_KEY").ok();
    if admin_key.is_some() {
        tracing::info!("admin API key authentication enabled");
    } else {
        tracing::warn!("COORD_ADMIN_KEY not set — admin API is unauthenticated");
    }
    coordinator = coordinator.with_admin_api_key(admin_key);

    let state = Arc::new(coordinator);

    // Spawn the federation broker background loop.
    let broker = state.federation_broker.clone();
    let tick_interval = broker.config().tick_interval;
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(tick_interval);
        interval.tick().await; // first tick fires immediately
        loop {
            interval.tick().await;
            if let Err(e) = broker.tick().await {
                tracing::warn!(error = %e, "federation broker tick failed");
            }
        }
    });
    tracing::info!(interval_secs = tick_interval.as_secs(), "federation broker started");

    let app = coord_api::router(state);

    tracing::info!(%listen_addr, domain = %config.domain, "listening");
    let listener = tokio::net::TcpListener::bind(listen_addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
