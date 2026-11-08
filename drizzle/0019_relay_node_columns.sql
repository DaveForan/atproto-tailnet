-- ADR-0020: Add container tracking columns to relay_nodes
ALTER TABLE "relay_nodes" ADD COLUMN IF NOT EXISTS "container_id" text;
ALTER TABLE "relay_nodes" ADD COLUMN IF NOT EXISTS "headscale_node_id" text;
ALTER TABLE "relay_nodes" ADD COLUMN IF NOT EXISTS "advertised_routes" jsonb NOT NULL DEFAULT '[]'::jsonb;
