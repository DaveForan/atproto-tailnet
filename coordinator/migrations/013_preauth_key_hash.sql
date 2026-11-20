-- Pre-auth keys at rest: the `key` column holds the SHA-256 (lowercase hex)
-- of the key, never the key itself. `key_prefix` is the short, non-secret
-- start of the key for listings.
ALTER TABLE coord_preauth_keys ADD COLUMN IF NOT EXISTS key_prefix TEXT NOT NULL DEFAULT '';

-- Hash the keys stored before this migration (plain keys start with "tskey-";
-- a hex digest never does). Both expressions read the old value of `key`.
UPDATE coord_preauth_keys
SET key_prefix = left(key, 12),
    key = encode(sha256(convert_to(key, 'UTF8')), 'hex')
WHERE key LIKE 'tskey-%';
