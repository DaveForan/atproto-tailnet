-- Per-tenant DNS configuration (ADR-0028).
CREATE TABLE IF NOT EXISTS coord_tenant_dns (
    tenant_id   TEXT PRIMARY KEY REFERENCES coord_tenants(id) ON DELETE CASCADE,
    dns         TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
