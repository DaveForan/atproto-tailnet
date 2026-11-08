-- ADR-0019: Migrate federation_links to per-side rows
-- broker_sessions: remoteTenantId → peerDid
-- federation_links: two-tenant → per-side with direction

-- New enums
DO $$ BEGIN
  CREATE TYPE "public"."link_direction" AS ENUM('outgoing', 'incoming');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."federation_posture" AS ENUM('closed', 'selective', 'open');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Add federation_posture to tenants
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "federation_posture" "federation_posture" NOT NULL DEFAULT 'selective';

-- Migrate federation_links
ALTER TABLE "federation_links" ADD COLUMN IF NOT EXISTS "local_tenant_id" uuid;
ALTER TABLE "federation_links" ADD COLUMN IF NOT EXISTS "peer_did" text;
ALTER TABLE "federation_links" ADD COLUMN IF NOT EXISTS "peer_broker_url" text;
ALTER TABLE "federation_links" ADD COLUMN IF NOT EXISTS "peer_name" text;
ALTER TABLE "federation_links" ADD COLUMN IF NOT EXISTS "direction" "link_direction";
ALTER TABLE "federation_links" ADD COLUMN IF NOT EXISTS "local_cidrs" jsonb DEFAULT '[]'::jsonb;
ALTER TABLE "federation_links" ADD COLUMN IF NOT EXISTS "peer_cidrs" jsonb DEFAULT '[]'::jsonb;

-- Migrate existing rows: requester side becomes outgoing
UPDATE "federation_links" SET
  "local_tenant_id" = "requester_tenant_id",
  "peer_did" = COALESCE(
    (SELECT "did" FROM "collective_dids" WHERE "tenant_id" = "federation_links"."target_tenant_id" LIMIT 1),
    'did:unknown:' || "target_tenant_id"
  ),
  "peer_broker_url" = COALESCE("target_broker_endpoint", "requester_broker_endpoint"),
  "direction" = 'outgoing',
  "local_cidrs" = "requester_cidrs",
  "peer_cidrs" = "target_cidrs"
WHERE "local_tenant_id" IS NULL;

-- Make new columns NOT NULL after migration
ALTER TABLE "federation_links" ALTER COLUMN "local_tenant_id" SET NOT NULL;
ALTER TABLE "federation_links" ALTER COLUMN "peer_did" SET NOT NULL;
ALTER TABLE "federation_links" ALTER COLUMN "direction" SET NOT NULL;
ALTER TABLE "federation_links" ALTER COLUMN "local_cidrs" SET NOT NULL;
ALTER TABLE "federation_links" ALTER COLUMN "peer_cidrs" SET NOT NULL;

-- Add FK
ALTER TABLE "federation_links" ADD CONSTRAINT "federation_links_local_tenant_id_tenants_id_fk"
  FOREIGN KEY ("local_tenant_id") REFERENCES "tenants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Drop old columns
ALTER TABLE "federation_links" DROP COLUMN IF EXISTS "requester_tenant_id";
ALTER TABLE "federation_links" DROP COLUMN IF EXISTS "target_tenant_id";
ALTER TABLE "federation_links" DROP COLUMN IF EXISTS "requester_cidrs";
ALTER TABLE "federation_links" DROP COLUMN IF EXISTS "target_cidrs";
ALTER TABLE "federation_links" DROP COLUMN IF EXISTS "requester_broker_endpoint";
ALTER TABLE "federation_links" DROP COLUMN IF EXISTS "target_broker_endpoint";

-- Drop old indexes
DROP INDEX IF EXISTS "federation_links_requester_idx";
DROP INDEX IF EXISTS "federation_links_target_idx";

-- New indexes
CREATE INDEX IF NOT EXISTS "federation_links_local_idx" ON "federation_links" ("local_tenant_id");
CREATE INDEX IF NOT EXISTS "federation_links_peer_did_idx" ON "federation_links" ("peer_did");
CREATE UNIQUE INDEX IF NOT EXISTS "federation_links_local_peer_active_uq"
  ON "federation_links" ("local_tenant_id", "peer_did")
  WHERE status IN ('pending', 'active');

-- Migrate broker_sessions
ALTER TABLE "broker_sessions" ADD COLUMN IF NOT EXISTS "peer_did" text;
UPDATE "broker_sessions" SET "peer_did" = COALESCE(
  (SELECT "did" FROM "collective_dids" WHERE "tenant_id" = "broker_sessions"."remote_tenant_id" LIMIT 1),
  'did:unknown:' || "remote_tenant_id"
) WHERE "peer_did" IS NULL;
ALTER TABLE "broker_sessions" ALTER COLUMN "peer_did" SET NOT NULL;
ALTER TABLE "broker_sessions" DROP COLUMN IF EXISTS "remote_tenant_id";
