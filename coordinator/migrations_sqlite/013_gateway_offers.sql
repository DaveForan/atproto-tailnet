-- The gateway of a tenant, as the relay process that runs it offers it (ADR-0038).
-- A control process registers the gateway node from the row.
CREATE TABLE IF NOT EXISTS coord_gateway_offers (
    tenant_id   TEXT PRIMARY KEY REFERENCES coord_tenants(id) ON DELETE CASCADE,
    node_key    TEXT NOT NULL,
    machine_key TEXT NOT NULL,
    disco_key   TEXT NOT NULL,
    region_id   INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
