use serde::Deserialize;
use std::net::SocketAddr;
use std::sync::Arc;
use tracing_subscriber::EnvFilter;

#[derive(Debug, Deserialize)]
#[serde(default)]
struct Config {
    listen: String,
    domain: String,
    derp_map_file: Option<String>,
    /// Public hostname of the built-in DERP relay (e.g. "derp.example.com").
    /// When set, it is the default DERP region and the STUN server starts.
    derp_hostname: Option<String>,
    /// UDP address of the STUN server (default "0.0.0.0:3478"; "off" disables).
    stun_listen: Option<String>,
    /// Required — one of: "sqlite", "postgres", "memory"
    store_backend: Option<String>,
    /// Path to SQLite database file (required when store_backend = "sqlite")
    sqlite_path: Option<String>,
    /// PostgreSQL connection URL (required when store_backend = "postgres")
    database_url: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            listen: "127.0.0.1:9443".into(),
            domain: "mesh.local".into(),
            derp_map_file: None,
            derp_hostname: None,
            stun_listen: None,
            store_backend: None,
            sqlite_path: None,
            database_url: None,
        }
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
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

    // Validate before touching the database so a weak key fails fast.
    let admin_key = validate_admin_key(std::env::var("COORD_ADMIN_KEY").ok())?;

    let control_key = load_or_create_control_key(std::env::var("COORD_CONTROL_KEY_PATH").ok())?;
    tracing::info!(
        control_public_key = hex::encode(control_key.public),
        "coordinator starting"
    );

    let control_key_path = std::env::var("COORD_CONTROL_KEY_PATH").ok();
    let mut coordinator = coord_api::CoordinatorState::new(control_key);

    // Built-in DERP relay (ADR-0027): a persistent key keeps the relay's
    // identity stable across restarts. By default it sits next to the control key.
    let relay_key_path = std::env::var("COORD_DERP_KEY_PATH").ok().or_else(|| {
        let dir = std::path::Path::new(control_key_path.as_deref()?).parent()?;
        Some(dir.join("derp.key").to_string_lossy().into_owned())
    });
    if let Some(secret) = load_or_create_secret(relay_key_path, "DERP relay key")? {
        coordinator = coordinator.with_relay_secret(secret);
    }

    let derp_hostname = std::env::var("COORD_DERP_HOSTNAME")
        .ok()
        .or(config.derp_hostname)
        .filter(|h| !h.is_empty());
    let stun_listen = std::env::var("COORD_STUN_LISTEN")
        .ok()
        .or(config.stun_listen)
        .unwrap_or_else(|| "0.0.0.0:3478".into());
    let stun_addr: Option<SocketAddr> = match stun_listen.as_str() {
        "off" => None,
        addr => Some(addr.parse().map_err(|e| anyhow::anyhow!("invalid COORD_STUN_LISTEN {addr:?}: {e}"))?),
    };

    let derp_path = std::env::var("COORD_DERP_MAP")
        .ok()
        .or(config.derp_map_file);

    // Which parts this process serves: all (default), control, or relay (ADR-0034)
    let role: coord_api::Role = std::env::var("COORD_ROLE")
        .unwrap_or_default()
        .parse()
        .map_err(|e: String| anyhow::anyhow!("invalid COORD_ROLE: {e}"))?;
    coordinator = coordinator.with_role(role);
    // Each relay process has its own DERP region. Region 1 is the default;
    // further relay replicas set COORD_DERP_REGION_ID (2-899).
    let region_id: i32 = match std::env::var("COORD_DERP_REGION_ID") {
        Ok(v) => v.parse().map_err(|e| anyhow::anyhow!("invalid COORD_DERP_REGION_ID {v:?}: {e}"))?,
        Err(_) => 1,
    };
    if !(coord_core::relay::RELAY_REGION_MIN..=coord_core::relay::RELAY_REGION_MAX).contains(&region_id) {
        anyhow::bail!("COORD_DERP_REGION_ID must be {}-{}", coord_core::relay::RELAY_REGION_MIN, coord_core::relay::RELAY_REGION_MAX);
    }
    if role == coord_api::Role::Relay && derp_hostname.is_none() {
        anyhow::bail!("COORD_ROLE=relay needs COORD_DERP_HOSTNAME (the public hostname of this relay)");
    }

    if let Some(hostname) = derp_hostname.as_ref().filter(|_| role.serves_relay()) {
        let stun_port = stun_addr.map(|a| a.port()).unwrap_or(0);
        coordinator = coordinator.with_relay_identity(coord_core::RelayInfo {
            region_id,
            hostname: hostname.clone(),
            stun_port,
        });
        tracing::info!(hostname = %hostname, region_id, stun_port, "this process is a DERP relay");
    } else if derp_path.is_none() && role == coord_api::Role::All {
        tracing::warn!(
            "no DERP relay configured (COORD_DERP_HOSTNAME / COORD_DERP_MAP): devices that cannot connect directly will not reach each other"
        );
    }

    // An explicit map file replaces the default map (it may list the built-in
    // relay's hostname itself, next to other regions).
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

    // Store backend selection — must be explicit
    let store_backend = std::env::var("COORD_STORE_BACKEND")
        .ok()
        .or(config.store_backend)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "store_backend is required in config file or COORD_STORE_BACKEND env var\n  \
             valid values: \"sqlite\", \"postgres\", \"memory\""
            )
        })?;

    match store_backend.as_str() {
        "postgres" => {
            let database_url = std::env::var("DATABASE_URL")
                .ok()
                .or(config.database_url)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "database_url is required when store_backend = \"postgres\"\n  \
                     set it in config file or DATABASE_URL env var"
                    )
                })?;

            let pool = coord_store::create_pool(&database_url).await?;
            let pg_store = coord_store::PgStore::new(pool.clone()).await?;
            tracing::info!("store: PostgreSQL (migrations applied)");
            coordinator = coordinator.with_store(coord_store::Store::Pg(pg_store));

            let fed_store = std::sync::Arc::new(coord_federation::PgFederationStore::new(pool));
            coordinator = coordinator.with_federation_store(fed_store);
            tracing::info!("federation store: PostgreSQL");
        }
        "sqlite" => {
            let sqlite_path = std::env::var("COORD_SQLITE_PATH")
                .ok()
                .or(config.sqlite_path)
                .unwrap_or_else(|| "coordinator.db".into());

            let pool = coord_store::create_sqlite_pool(&sqlite_path).await?;
            let sqlite_store = coord_store::SqliteStore::new(pool.clone()).await?;
            tracing::info!(path = %sqlite_path, "store: SQLite (WAL mode, migrations applied)");
            coordinator = coordinator.with_store(coord_store::Store::Sqlite(sqlite_store));

            let fed_store = std::sync::Arc::new(coord_federation::SqliteFederationStore::new(pool));
            coordinator = coordinator.with_federation_store(fed_store);
            tracing::info!("federation store: SQLite");
        }
        "memory" => {
            tracing::warn!("store: in-memory — all data will be lost on restart");
        }
        other => {
            anyhow::bail!(
                "unknown store_backend: \"{}\"\n  valid values: \"sqlite\", \"postgres\", \"memory\"",
                other
            );
        }
    }

    if admin_key.is_some() {
        tracing::info!("admin API key authentication enabled");
    } else {
        tracing::warn!(
            "COORD_ADMIN_KEY not set — admin API is disabled (all admin requests return 503)"
        );
    }
    coordinator = coordinator.with_admin_api_key(admin_key);

    // Interactive device sign-in (ADR-0032): where devices without a key are sent
    let device_auth_url = std::env::var("COORD_DEVICE_AUTH_URL").ok().filter(|u| !u.is_empty());
    match &device_auth_url {
        Some(url) => tracing::info!(url = %url, "interactive device sign-in enabled"),
        None => tracing::info!("COORD_DEVICE_AUTH_URL not set: devices need an auth key"),
    }
    coordinator = coordinator.with_device_auth_url(device_auth_url);

    // The TS service is the authoritative federation endpoint; the Rust CFP
    // implementation only runs when explicitly enabled.
    let federation_enabled = std::env::var("COORD_FEDERATION_ENABLED")
        .map(|v| v == "true" || v == "1")
        .unwrap_or(false);
    coordinator = coordinator.with_federation_enabled(federation_enabled);

    let state = Arc::new(coordinator);
    // Per-tenant configuration lives in the store; other replicas report changes (ADR-0034)
    if role.serves_control() {
        state.load_config().await;
        state.spawn_replica_listener();
    }
    // Relay discovery: report this relay, and build the DERP map from the live relays
    state.refresh_relays().await;
    state.spawn_relay_tasks();

    if federation_enabled && role.serves_control() {
        // Spawn the federation broker background loop.
        let broker = state.federation_broker().clone();
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
        tracing::info!(
            interval_secs = tick_interval.as_secs(),
            "federation broker started"
        );
    } else {
        tracing::info!("Rust federation endpoints disabled (COORD_FEDERATION_ENABLED not set)");
    }

    if let (Some(_), Some(addr), true) = (&derp_hostname, stun_addr, role.serves_relay()) {
        let socket = tokio::net::UdpSocket::bind(addr).await
            .map_err(|e| anyhow::anyhow!("cannot bind STUN on {addr}: {e}"))?;
        tracing::info!(%addr, "STUN server listening");
        tokio::spawn(async move {
            if let Err(e) = coord_derp::stun::serve(socket).await {
                tracing::error!(error = %e, "STUN server stopped");
            }
        });
    }

    if role.serves_control() {
        coord_api::spawn_ephemeral_sweeper(state.clone());
        tracing::info!("ephemeral node sweeper started");
    }

    let app = coord_api::router(state);

    tracing::info!(%listen_addr, domain = %config.domain, "listening");
    let listener = tokio::net::TcpListener::bind(listen_addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

/// Minimum COORD_ADMIN_KEY length (32 chars ~ 128+ bits for a random key).
const MIN_ADMIN_KEY_LEN: usize = 32;

/// Refuse to start with a guessable admin key. Unset keeps the admin API
/// disabled (503); set-but-weak is a hard error rather than a silent downgrade.
fn validate_admin_key(key: Option<String>) -> anyhow::Result<Option<String>> {
    let Some(key) = key else { return Ok(None) };
    let lower = key.to_ascii_lowercase();
    if lower.contains("change-me") || lower.contains("changeme") {
        anyhow::bail!(
            "COORD_ADMIN_KEY contains a placeholder (\"change-me\"/\"changeme\"); \
             set it to a random secret, e.g. `openssl rand -hex 32`"
        );
    }
    if key.chars().count() < MIN_ADMIN_KEY_LEN {
        anyhow::bail!(
            "COORD_ADMIN_KEY is too short ({} chars, minimum {MIN_ADMIN_KEY_LEN}); \
             set it to a random secret, e.g. `openssl rand -hex 32`, or unset it to disable the admin API",
            key.chars().count()
        );
    }
    Ok(Some(key))
}

/// Clients pin the control server's Noise key, so it must survive restarts.
fn load_or_create_control_key(path: Option<String>) -> anyhow::Result<coord_core::ControlKey> {
    match load_or_create_secret(path, "control key")? {
        Some(secret) => Ok(coord_noise::control_key_from_secret(secret)),
        None => {
            tracing::warn!(
                "COORD_CONTROL_KEY_PATH not set; using an ephemeral control key (clients re-handshake after every restart)"
            );
            Ok(coord_noise::generate_control_key())
        }
    }
}

/// Read a 32-byte hex secret from `path`, creating it (mode 0600) when the
/// file does not exist. `None` when no path is configured.
fn load_or_create_secret(path: Option<String>, what: &str) -> anyhow::Result<Option<[u8; 32]>> {
    let Some(path) = path else { return Ok(None) };
    match std::fs::read_to_string(&path) {
        Ok(contents) => {
            let bytes = hex::decode(contents.trim())
                .map_err(|e| anyhow::anyhow!("{what} at {path} is not hex: {e}"))?;
            let secret: [u8; 32] = bytes
                .try_into()
                .map_err(|_| anyhow::anyhow!("{what} at {path} must be 32 bytes"))?;
            Ok(Some(secret))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            use rand::RngCore;
            let mut secret = [0u8; 32];
            rand::rng().fill_bytes(&mut secret);
            if let Some(dir) = std::path::Path::new(&path).parent() {
                std::fs::create_dir_all(dir)?;
            }
            write_secret_file(&path, &hex::encode(secret))?;
            tracing::info!(path = %path, "generated new {what}");
            Ok(Some(secret))
        }
        Err(e) => Err(anyhow::anyhow!("cannot read {what} at {path}: {e}")),
    }
}

fn write_secret_file(path: &str, contents: &str) -> anyhow::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)?.write_all(contents.as_bytes())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admin_key_validation() {
        assert!(validate_admin_key(None).unwrap().is_none());
        let good = "a".repeat(32);
        assert_eq!(validate_admin_key(Some(good.clone())).unwrap(), Some(good));
        assert!(validate_admin_key(Some("".into())).is_err());
        assert!(validate_admin_key(Some("short-key".into())).is_err());
        assert!(validate_admin_key(Some("a".repeat(31))).is_err());
        let placeholder = format!("{}CHANGE-ME", "x".repeat(40));
        let err = validate_admin_key(Some(placeholder)).unwrap_err().to_string();
        assert!(err.contains("placeholder"), "{err}");
        assert!(validate_admin_key(Some(format!("{}ChangeMe", "x".repeat(40)))).is_err());
    }
}
