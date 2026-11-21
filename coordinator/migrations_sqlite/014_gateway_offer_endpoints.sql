-- The public UDP addresses of a gateway (ADR-0029 phase 2): "ip:port" values with commas between them.
-- Empty: the gateway has no direct path and devices use the relay.
ALTER TABLE coord_gateway_offers ADD COLUMN endpoints TEXT NOT NULL DEFAULT '';
