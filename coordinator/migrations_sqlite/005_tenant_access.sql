-- Per-tenant device access mode and rules (ADR-0036).
CREATE TABLE IF NOT EXISTS coord_tenant_access (
    tenant_id   TEXT PRIMARY KEY REFERENCES coord_tenants(id) ON DELETE CASCADE,
    access      TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
