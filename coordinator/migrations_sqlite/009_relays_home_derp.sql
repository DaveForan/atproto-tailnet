-- Relay regions (ADR-0034, stage B).
CREATE TABLE IF NOT EXISTS coord_relays (
    region_id   INTEGER PRIMARY KEY,
    hostname    TEXT NOT NULL,
    stun_port   INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL
);

ALTER TABLE coord_nodes ADD COLUMN home_derp INTEGER;
