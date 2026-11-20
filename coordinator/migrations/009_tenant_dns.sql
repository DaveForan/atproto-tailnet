-- Per-tenant DNS configuration (ADR-0028): base domain, tailnet label,
-- upstream resolvers and service records.
CREATE TABLE IF NOT EXISTS coord_tenant_dns (
    tenant_id   UUID PRIMARY KEY REFERENCES coord_tenants(id) ON DELETE CASCADE,
    dns         JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
