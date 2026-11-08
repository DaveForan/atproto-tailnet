CREATE TABLE IF NOT EXISTS coord_tenants (
    id              UUID PRIMARY KEY,
    slug            TEXT NOT NULL UNIQUE,
    parent_id       UUID REFERENCES coord_tenants(id),
    federation_posture TEXT NOT NULL DEFAULT 'closed',
    ipv4_prefix     TEXT NOT NULL DEFAULT '100.64.0.0/10',
    ipv6_prefix     TEXT NOT NULL DEFAULT 'fd7a:115c:a1e0::/48',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_coord_tenants_parent ON coord_tenants (parent_id);
CREATE INDEX idx_coord_tenants_slug ON coord_tenants (slug);

-- Add FK from nodes to tenants (existing nodes won't have matching tenants yet,
-- so we make this a soft reference for now — the coordinator validates at the app layer)
