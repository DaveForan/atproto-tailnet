-- Federation links between local tenants and remote peers
CREATE TABLE IF NOT EXISTS coord_federation_links (
    id              UUID PRIMARY KEY,
    local_tenant_id UUID NOT NULL REFERENCES coord_tenants(id) ON DELETE CASCADE,
    peer_did        TEXT NOT NULL,
    peer_broker_url TEXT,
    peer_name       TEXT,
    direction       TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'rejected', 'revoked')),
    local_cidrs     TEXT[] NOT NULL DEFAULT '{}',
    peer_cidrs      TEXT[] NOT NULL DEFAULT '{}',
    protocol_version TEXT,
    message         TEXT,
    signed_request  TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_coord_fed_links_tenant ON coord_federation_links (local_tenant_id);
CREATE INDEX idx_coord_fed_links_status ON coord_federation_links (status);
CREATE INDEX idx_coord_fed_links_peer ON coord_federation_links (peer_did);
-- Only one active link per tenant+peer pair
CREATE UNIQUE INDEX idx_coord_fed_links_active ON coord_federation_links (local_tenant_id, peer_did) WHERE status IN ('pending', 'active');

-- Broker sessions for active federation links
CREATE TABLE IF NOT EXISTS coord_broker_sessions (
    id                  UUID PRIMARY KEY,
    federation_link_id  UUID NOT NULL REFERENCES coord_federation_links(id) ON DELETE CASCADE,
    local_tenant_id     UUID NOT NULL REFERENCES coord_tenants(id) ON DELETE CASCADE,
    peer_did            TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'connecting' CHECK (status IN ('connecting', 'established', 'degraded', 'disconnected')),
    cfp_session_id      TEXT,
    remote_endpoint     TEXT,
    protocol_version    TEXT,
    exported_routes     TEXT[] NOT NULL DEFAULT '{}',
    imported_routes     TEXT[] NOT NULL DEFAULT '{}',
    last_keepalive      TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_coord_sessions_link ON coord_broker_sessions (federation_link_id);
CREATE INDEX idx_coord_sessions_tenant ON coord_broker_sessions (local_tenant_id);
CREATE INDEX idx_coord_sessions_cfp ON coord_broker_sessions (cfp_session_id);
-- One session per link+tenant
CREATE UNIQUE INDEX idx_coord_sessions_unique ON coord_broker_sessions (federation_link_id, local_tenant_id);

-- Collective DIDs for tenants
CREATE TABLE IF NOT EXISTS coord_collective_dids (
    tenant_id           UUID PRIMARY KEY REFERENCES coord_tenants(id) ON DELETE CASCADE,
    did                 TEXT NOT NULL UNIQUE,
    public_key_jwk      JSONB NOT NULL,
    encrypted_private_key TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_coord_dids_did ON coord_collective_dids (did);
