-- Owner machine locks (ADR-0035): a member's devices in a tenant are limited
-- to a fixed set of machine keys.
CREATE TABLE IF NOT EXISTS coord_owner_locks (
    tenant_id   UUID NOT NULL REFERENCES coord_tenants(id) ON DELETE CASCADE,
    owner       TEXT NOT NULL,
    lock        JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, owner)
);
