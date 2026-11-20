-- Coordinator state that every replica must see (ADR-0034).

-- Per-tenant configuration by kind: acl, derp, auto_approvers, identity.
CREATE TABLE IF NOT EXISTS coord_tenant_config (
    tenant_id   UUID NOT NULL REFERENCES coord_tenants(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    value       JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, kind)
);

-- Pending interactive device sign-ins (ADR-0032). `decision` NULL = pending.
CREATE TABLE IF NOT EXISTS coord_sign_ins (
    id          TEXT PRIMARY KEY,
    machine_key TEXT NOT NULL,
    hostname    TEXT NOT NULL,
    os          TEXT NOT NULL,
    decision    TEXT,
    expires_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS coord_sign_ins_machine_idx ON coord_sign_ins (machine_key);
