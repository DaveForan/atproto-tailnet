CREATE TABLE IF NOT EXISTS coord_nodes (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       UUID NOT NULL,
    machine_key     BYTEA NOT NULL UNIQUE,
    node_key        BYTEA NOT NULL,
    disco_key       TEXT,
    stable_id       TEXT NOT NULL UNIQUE,
    ipv4            TEXT NOT NULL UNIQUE,
    hostname        TEXT NOT NULL DEFAULT 'unknown',
    os              TEXT NOT NULL DEFAULT 'unknown',
    endpoints       JSONB NOT NULL DEFAULT '[]',
    online          BOOLEAN NOT NULL DEFAULT TRUE,
    registered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_coord_nodes_tenant ON coord_nodes (tenant_id);
CREATE INDEX idx_coord_nodes_machine_key ON coord_nodes (machine_key);
CREATE INDEX idx_coord_nodes_online ON coord_nodes (tenant_id, online);

CREATE TABLE IF NOT EXISTS coord_preauth_keys (
    key             TEXT PRIMARY KEY,
    tenant_id       UUID NOT NULL,
    used            BOOLEAN NOT NULL DEFAULT FALSE,
    reusable        BOOLEAN NOT NULL DEFAULT FALSE,
    expires_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_coord_preauth_keys_tenant ON coord_preauth_keys (tenant_id);

-- Sequence for allocating CGNAT IPs (100.64.0.0/10)
CREATE SEQUENCE IF NOT EXISTS coord_ipv4_seq START WITH 1;
