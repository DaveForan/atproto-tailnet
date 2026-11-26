-- Who must admit a device before it gets access: 0 admitted, 1 an approver, 2 the owner.
-- Devices that exist stay admitted.
ALTER TABLE coord_nodes ADD COLUMN IF NOT EXISTS hold SMALLINT NOT NULL DEFAULT 0;
