-- Coordinator state kept in the store (ADR-0034).
CREATE TABLE IF NOT EXISTS coord_tenant_config (
    tenant_id   TEXT NOT NULL REFERENCES coord_tenants(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (tenant_id, kind)
);

CREATE TABLE IF NOT EXISTS coord_sign_ins (
    id          TEXT PRIMARY KEY,
    machine_key TEXT NOT NULL,
    hostname    TEXT NOT NULL,
    os          TEXT NOT NULL,
    decision    TEXT,
    expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS coord_sign_ins_machine_idx ON coord_sign_ins (machine_key);
