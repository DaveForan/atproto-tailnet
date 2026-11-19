-- Pre-auth key metadata: non-secret id, owner, tags, ephemeral, revocation.
ALTER TABLE coord_preauth_keys ADD COLUMN id TEXT;
ALTER TABLE coord_preauth_keys ADD COLUMN owner TEXT;
ALTER TABLE coord_preauth_keys ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE coord_preauth_keys ADD COLUMN ephemeral BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE coord_preauth_keys ADD COLUMN revoked_at TEXT;

-- Backfill ids for existing keys with random v4-shaped UUIDs.
UPDATE coord_preauth_keys SET id =
    lower(hex(randomblob(4))) || '-' ||
    lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', 1 + (abs(random()) % 4), 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6)))
WHERE id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_coord_preauth_keys_id ON coord_preauth_keys (id);
CREATE INDEX IF NOT EXISTS idx_coord_preauth_keys_owner ON coord_preauth_keys (tenant_id, owner);

-- Node ownership, tags, ephemeral flag and subnet/exit routes (JSON arrays).
ALTER TABLE coord_nodes ADD COLUMN owner TEXT;
ALTER TABLE coord_nodes ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE coord_nodes ADD COLUMN ephemeral BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE coord_nodes ADD COLUMN advertised_routes TEXT NOT NULL DEFAULT '[]';
ALTER TABLE coord_nodes ADD COLUMN approved_routes TEXT NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_coord_nodes_owner ON coord_nodes (tenant_id, owner);
CREATE INDEX IF NOT EXISTS idx_coord_nodes_ephemeral ON coord_nodes (ephemeral, online);
