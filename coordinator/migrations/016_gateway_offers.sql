-- The gateway of a tenant, as the relay process that runs it offers it (ADR-0038).
-- The relay writes only this table: its public keys (hex) and its DERP region.
-- A control process registers the gateway node from the row.
CREATE TABLE IF NOT EXISTS coord_gateway_offers (
    tenant_id   UUID PRIMARY KEY REFERENCES coord_tenants(id) ON DELETE CASCADE,
    node_key    TEXT NOT NULL,
    machine_key TEXT NOT NULL,
    disco_key   TEXT NOT NULL,
    region_id   INTEGER NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
