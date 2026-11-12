CREATE TABLE IF NOT EXISTS coord_tenants (
    id              TEXT PRIMARY KEY,
    slug            TEXT NOT NULL UNIQUE,
    parent_id       TEXT REFERENCES coord_tenants(id),
    federation_posture TEXT NOT NULL DEFAULT 'closed',
    ipv4_prefix     TEXT NOT NULL DEFAULT '100.64.0.0/10',
    ipv6_prefix     TEXT NOT NULL DEFAULT 'fd7a:115c:a1e0::/48',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_coord_tenants_parent ON coord_tenants (parent_id);
CREATE INDEX idx_coord_tenants_slug ON coord_tenants (slug);

CREATE TABLE IF NOT EXISTS coord_nodes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id       TEXT NOT NULL,
    machine_key     BLOB NOT NULL UNIQUE,
    node_key        BLOB NOT NULL,
    disco_key       TEXT,
    stable_id       TEXT NOT NULL UNIQUE,
    ipv4            TEXT NOT NULL UNIQUE,
    hostname        TEXT NOT NULL DEFAULT 'unknown',
    os              TEXT NOT NULL DEFAULT 'unknown',
    endpoints       TEXT NOT NULL DEFAULT '[]',
    online          BOOLEAN NOT NULL DEFAULT 1,
    session_generation INTEGER NOT NULL DEFAULT 0,
    registered_at   TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_coord_nodes_tenant ON coord_nodes (tenant_id);
CREATE INDEX idx_coord_nodes_machine_key ON coord_nodes (machine_key);
CREATE INDEX idx_coord_nodes_online ON coord_nodes (tenant_id, online);

CREATE TABLE IF NOT EXISTS coord_preauth_keys (
    key             TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL,
    used            BOOLEAN NOT NULL DEFAULT 0,
    reusable        BOOLEAN NOT NULL DEFAULT 0,
    expires_at      TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_coord_preauth_keys_tenant ON coord_preauth_keys (tenant_id);

-- Counter table replacing PostgreSQL's coord_ipv4_seq sequence
CREATE TABLE IF NOT EXISTS coord_ipv4_counter (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    next_offset     INTEGER NOT NULL DEFAULT 1
);

INSERT OR IGNORE INTO coord_ipv4_counter (id, next_offset) VALUES (1, 1);

-- Federation links between local tenants and remote peers
CREATE TABLE IF NOT EXISTS coord_federation_links (
    id              TEXT PRIMARY KEY,
    local_tenant_id TEXT NOT NULL REFERENCES coord_tenants(id) ON DELETE CASCADE,
    peer_did        TEXT NOT NULL,
    peer_broker_url TEXT,
    peer_name       TEXT,
    direction       TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'rejected', 'revoked')),
    local_cidrs     TEXT NOT NULL DEFAULT '[]',
    peer_cidrs      TEXT NOT NULL DEFAULT '[]',
    protocol_version TEXT,
    message         TEXT,
    signed_request  TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_coord_fed_links_tenant ON coord_federation_links (local_tenant_id);
CREATE INDEX IF NOT EXISTS idx_coord_fed_links_status ON coord_federation_links (status);
CREATE INDEX IF NOT EXISTS idx_coord_fed_links_peer ON coord_federation_links (peer_did);
CREATE UNIQUE INDEX IF NOT EXISTS idx_coord_fed_links_active ON coord_federation_links (local_tenant_id, peer_did) WHERE status IN ('pending', 'active');

-- Broker sessions for active federation links
CREATE TABLE IF NOT EXISTS coord_broker_sessions (
    id                  TEXT PRIMARY KEY,
    federation_link_id  TEXT NOT NULL REFERENCES coord_federation_links(id) ON DELETE CASCADE,
    local_tenant_id     TEXT NOT NULL REFERENCES coord_tenants(id) ON DELETE CASCADE,
    peer_did            TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'connecting' CHECK (status IN ('connecting', 'established', 'degraded', 'disconnected')),
    cfp_session_id      TEXT,
    remote_endpoint     TEXT,
    protocol_version    TEXT,
    exported_routes     TEXT NOT NULL DEFAULT '[]',
    imported_routes     TEXT NOT NULL DEFAULT '[]',
    last_keepalive      TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_coord_sessions_link ON coord_broker_sessions (federation_link_id);
CREATE INDEX IF NOT EXISTS idx_coord_sessions_tenant ON coord_broker_sessions (local_tenant_id);
CREATE INDEX IF NOT EXISTS idx_coord_sessions_cfp ON coord_broker_sessions (cfp_session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_coord_sessions_unique ON coord_broker_sessions (federation_link_id, local_tenant_id);

-- Collective DIDs for tenants
CREATE TABLE IF NOT EXISTS coord_collective_dids (
    tenant_id           TEXT PRIMARY KEY REFERENCES coord_tenants(id) ON DELETE CASCADE,
    did                 TEXT NOT NULL UNIQUE,
    public_key_jwk      TEXT NOT NULL,
    encrypted_private_key TEXT NOT NULL,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_coord_dids_did ON coord_collective_dids (did);
