-- Per-tenant device access mode and rules (ADR-0036). Persisted so the rules
-- hold after a restart and with more than one coordinator replica.
CREATE TABLE IF NOT EXISTS coord_tenant_access (
    tenant_id   UUID PRIMARY KEY REFERENCES coord_tenants(id) ON DELETE CASCADE,
    access      JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
