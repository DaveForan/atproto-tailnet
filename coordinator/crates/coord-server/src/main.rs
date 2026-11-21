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
    /// Public hostname of the built-in DERP relay, e.g. "derp.example.com".
    /// When set, it is the default DERP region and the STUN server starts.
    derp_hostname: Option<String>,
    /// UDP address of the STUN server. Default "0.0.0.0:3478"; "off" disables it.
    stun_listen: Option<String>,
    /// Required: "sqlite", "postgres" or "memory".
    store_backend: Option<String>,
    /// SQLite database file, used when store_backend = "sqlite".
    sqlite_path: Option<String>,
    /// PostgreSQL connection URL, required when store_backend = "postgres".
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

    // Env vars override the config file.
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
    let mut coordinator = coord_api::CoordinatorState::builder(control_key);

    // Parts this process serves: all (default), control, or relay (ADR-0034).
    let role: coord_api::Role = std::env::var("COORD_ROLE")
        .unwrap_or_default()
        .parse()
        .map_err(|e: String| anyhow::anyhow!("invalid COORD_ROLE: {e}"))?;
    coordinator = coordinator.with_role(role);
    // The TS service is the federation endpoint. The Rust CFP endpoints need handshake callbacks.
    // So enabling them here fails before any database work.
    let federation_enabled = std::env::var("COORD_FEDERATION_ENABLED")
        .map(|v| v == "true" || v == "1")
        .unwrap_or(false);
    coordinator = coordinator.with_federation_enabled(federation_enabled);
    coordinator.validate().map_err(|e| anyhow::anyhow!("COORD_FEDERATION_ENABLED: {e}"))?;

    // Built-in DERP relay (ADR-0027): a persistent key keeps its identity across restarts.
    // The key file defaults to the control key's folder.
    let relay_key_path = std::env::var("COORD_DERP_KEY_PATH").ok().or_else(|| {
        let dir = std::path::Path::new(control_key_path.as_deref()?).parent()?;
        Some(dir.join("derp.key").to_string_lossy().into_owned())
    });
    // A control-only process has no relay, and its key folder may be read-only.
    if role.serves_relay()
        && let Some(secret) = load_or_create_secret(relay_key_path, "DERP relay key")? {
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

    // Each relay process has its own DERP region. Region 1 is the default.
    // Other relay replicas set COORD_DERP_REGION_ID (2-899).
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

    // An explicit map file replaces the default map. It may list the built-in relay too.
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

    // The store backend must be explicit.
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
            // Relays may use a least-privilege role (scripts/relay-db-role.sql) that cannot create tables.
            // So relays only verify the schema. Control processes apply the migrations.
            let pg_store = if role == coord_api::Role::Relay {
                let s = coord_store::PgStore::new_verified(pool.clone())
                    .await
                    .map_err(|e| anyhow::anyhow!("relay store check failed: {e}"))?;
                tracing::info!(version = coord_store::PgStore::required_schema_version(), "store: PostgreSQL (relay: schema verified, no migrations run)");
                s
            } else {
                let s = coord_store::PgStore::new(pool.clone()).await?;
                tracing::info!("store: PostgreSQL (migrations applied)");
                s
            };
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

    // Gateway (ADR-0029): HTTPS for named services inside tailnets.
    // It needs the base domain's wildcard certificate and this process's relay.
    let gateway_cert = std::env::var("COORD_GATEWAY_CERT").ok().filter(|p| !p.is_empty());
    let gateway_key = std::env::var("COORD_GATEWAY_KEY").ok().filter(|p| !p.is_empty());
    if role.serves_relay() && (gateway_cert.is_none() || gateway_key.is_none()) {
        tracing::warn!(
            cert_set = gateway_cert.is_some(),
            key_set = gateway_key.is_some(),
            "COORD_GATEWAY_CERT / COORD_GATEWAY_KEY not both set: this relay runs no gateway, named HTTPS services (ADR-0029) are off here"
        );
    }
    let mut pending_gateway: Option<([u8; 32], String, String)> = None;
    if let (Some(cert), Some(key), true) = (gateway_cert, gateway_key, role.serves_relay()) {
        let secret_path = std::env::var("COORD_GATEWAY_SECRET_PATH").ok().or_else(|| {
            let dir = std::path::Path::new(control_key_path.as_deref()?).parent()?;
            Some(dir.join("gateway.key").to_string_lossy().into_owned())
        });
        let secret = load_or_create_secret(secret_path, "gateway secret")?
            .ok_or_else(|| anyhow::anyhow!("the gateway needs COORD_GATEWAY_SECRET_PATH or COORD_CONTROL_KEY_PATH for its secret"))?;
        // Caddy usually obtains the certificate after the first start, and a helper copies it.
        // Start without it and enable the gateway when it appears.
        match coord_gateway::proxy::Certificate::from_files(&cert, &key) {
            Ok(c) => {
                let certificate = Arc::new(c);
                coord_gateway::proxy::spawn_reload(certificate.clone(), std::time::Duration::from_secs(6 * 3600));
                coordinator = coordinator.with_gateway(secret, certificate);
                tracing::info!(cert = %cert, "gateway enabled: named HTTPS services");
            }
            Err(e) => {
                tracing::warn!(error = %e, cert = %cert, key = %key, "gateway certificate not usable yet: will enable named HTTPS services when it appears");
                pending_gateway = Some((secret, cert, key));
            }
        }
    }

    // Interactive device sign-in (ADR-0032): where devices without a key are sent.
    let device_auth_url = std::env::var("COORD_DEVICE_AUTH_URL").ok().filter(|u| !u.is_empty());
    match &device_auth_url {
        Some(url) => tracing::info!(url = %url, "interactive device sign-in enabled"),
        None => tracing::info!("COORD_DEVICE_AUTH_URL not set: devices need an auth key"),
    }
    coordinator = coordinator.with_device_auth_url(device_auth_url);

    // Behind Caddy every connection comes from the proxy.
    // Only these CIDRs (comma-separated, default none) may set X-Forwarded-For.
    let trusted_proxies = coord_api::client_ip::TrustedProxies::parse(
        &std::env::var("COORD_TRUSTED_PROXIES").unwrap_or_default(),
    )
    .map_err(|e| anyhow::anyhow!("COORD_TRUSTED_PROXIES: {e}"))?;
    if trusted_proxies.is_empty() {
        tracing::info!("COORD_TRUSTED_PROXIES not set: client addresses are the TCP peers");
    }
    coordinator = coordinator.with_trusted_proxies(trusted_proxies);

    // Noise connections are open to anyone before authentication, so both caps bound unauthenticated load.
    let max_noise = env_count("COORD_MAX_NOISE_CONNS", coord_api::DEFAULT_MAX_NOISE_CONNECTIONS)?;
    let max_noise_per_ip = env_count("COORD_MAX_NOISE_CONNS_PER_IP", coord_api::DEFAULT_MAX_NOISE_CONNECTIONS_PER_IP)?;
    tracing::info!(max_noise, max_noise_per_ip, "noise connection limits");
    coordinator = coordinator
        .with_max_noise_connections(max_noise)
        .with_max_noise_connections_per_ip(max_noise_per_ip);

    let state = Arc::new(coordinator.build());
    // Per-tenant configuration lives in the store. Other replicas report changes (ADR-0034).
    if role.serves_control() {
        state.load_config().await;
        state.spawn_replica_listener();
    }
    // Relay discovery: report this relay and build the DERP map from the live relays.
    state.refresh_relays().await;
    state.spawn_relay_tasks();
    // Tailnets that already have HTTPS services get their gateway back.
    state.start_gateways().await;
    if let Some((secret, cert, key)) = pending_gateway {
        let state = state.clone();
        tokio::spawn(async move {
            let mut warned = 0u32;
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                match coord_gateway::proxy::Certificate::from_files(&cert, &key) {
                    Ok(c) => {
                        let certificate = Arc::new(c);
                        coord_gateway::proxy::spawn_reload(certificate.clone(), std::time::Duration::from_secs(6 * 3600));
                        if state.enable_gateway(secret, certificate).await {
                            tracing::info!(cert = %cert, "gateway certificate arrived: named HTTPS services enabled");
                        }
                        return;
                    }
                    Err(e) => {
                        warned += 1;
                        // Every ~10 minutes, so a missing certificate stays visible in the logs.
                        if warned.is_multiple_of(60) {
                            tracing::error!(error = %e, cert = %cert, key = %key, "gateway certificate still not usable: named HTTPS services are off");
                        }
                    }
                }
            }
        });
    }

    if federation_enabled && role.serves_control() {
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
    // Peer addresses feed the client address of device sign-ins (ADR-0032).
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await?;

    Ok(())
}

/// Minimum COORD_ADMIN_KEY length (32 chars ~ 128+ bits for a random key).
const MIN_ADMIN_KEY_LEN: usize = 32;

/// A positive count from env `name`, or `default` when unset or empty.
fn env_count(name: &str, default: usize) -> anyhow::Result<usize> {
    parse_count(name, std::env::var(name).ok().as_deref(), default)
}

fn parse_count(name: &str, value: Option<&str>, default: usize) -> anyhow::Result<usize> {
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        None => Ok(default),
        Some(v) => match v.parse::<usize>() {
            Ok(n) if n > 0 => Ok(n),
            _ => Err(anyhow::anyhow!("{name} must be a positive integer, got {v:?}")),
        },
    }
}

/// Refuse a guessable admin key. Unset disables the admin API (503).
/// A weak key is a hard error, not a silent downgrade.
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

/// Read a 32-byte hex secret from `path`, or create it with mode 0600.
/// `None` when no path is configured.
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

    #[test]
    fn counts_from_env_need_a_positive_integer() {
        assert_eq!(parse_count("X", None, 7).unwrap(), 7);
        assert_eq!(parse_count("X", Some(" "), 7).unwrap(), 7);
        assert_eq!(parse_count("X", Some("64"), 7).unwrap(), 64);
        assert!(parse_count("X", Some("0"), 7).is_err());
        assert!(parse_count("X", Some("-1"), 7).is_err());
        assert!(parse_count("X", Some("lots"), 7).is_err());
    }
}
