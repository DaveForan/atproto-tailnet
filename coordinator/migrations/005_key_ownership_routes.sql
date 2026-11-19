-- Pre-auth key metadata: non-secret id, owner, tags, ephemeral, revocation.
ALTER TABLE coord_preauth_keys ADD COLUMN id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE coord_preauth_keys ADD COLUMN owner TEXT;
ALTER TABLE coord_preauth_keys ADD COLUMN tags JSONB NOT NULL DEFAULT '[]';
ALTER TABLE coord_preauth_keys ADD COLUMN ephemeral BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE coord_preauth_keys ADD COLUMN revoked_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_coord_preauth_keys_id ON coord_preauth_keys (id);
CREATE INDEX IF NOT EXISTS idx_coord_preauth_keys_owner ON coord_preauth_keys (tenant_id, owner);

-- Node ownership, tags, ephemeral flag and subnet/exit routes (JSON arrays).
ALTER TABLE coord_nodes ADD COLUMN owner TEXT;
ALTER TABLE coord_nodes ADD COLUMN tags JSONB NOT NULL DEFAULT '[]';
ALTER TABLE coord_nodes ADD COLUMN ephemeral BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE coord_nodes ADD COLUMN advertised_routes JSONB NOT NULL DEFAULT '[]';
ALTER TABLE coord_nodes ADD COLUMN approved_routes JSONB NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_coord_nodes_owner ON coord_nodes (tenant_id, owner);
CREATE INDEX IF NOT EXISTS idx_coord_nodes_ephemeral ON coord_nodes (ephemeral, online);
