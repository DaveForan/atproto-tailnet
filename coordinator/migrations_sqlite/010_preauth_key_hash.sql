-- Pre-auth keys at rest: the `key` column holds the SHA-256 (lowercase hex)
-- of the key, never the key itself. `key_prefix` is the short, non-secret
-- start of the key for listings.
ALTER TABLE coord_preauth_keys ADD COLUMN key_prefix TEXT NOT NULL DEFAULT '';

-- SQLite has no SHA-256 function: the prefix is filled here, and
-- SqliteStore::new hashes every key that still starts with "tskey-" right
-- after the migrations run (before the store serves any request).
UPDATE coord_preauth_keys SET key_prefix = substr(key, 1, 12) WHERE key LIKE 'tskey-%';
