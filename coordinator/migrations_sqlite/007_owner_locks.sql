-- Owner machine locks (ADR-0035).
CREATE TABLE IF NOT EXISTS coord_owner_locks (
    tenant_id   TEXT NOT NULL REFERENCES coord_tenants(id) ON DELETE CASCADE,
    owner       TEXT NOT NULL,
    lock        TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (tenant_id, owner)
);
