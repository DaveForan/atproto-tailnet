-- Relay regions (ADR-0034, stage B).

-- Live relay processes. A relay writes its row every few seconds; control
-- replicas build the default DERP map from the rows that are fresh.
CREATE TABLE IF NOT EXISTS coord_relays (
    region_id   INTEGER PRIMARY KEY,
    hostname    TEXT NOT NULL,
    stun_port   INTEGER NOT NULL,
    last_seen   BIGINT NOT NULL
);

-- The relay region a device reports as its home (NetInfo.PreferredDERP).
ALTER TABLE coord_nodes ADD COLUMN IF NOT EXISTS home_derp INTEGER;
