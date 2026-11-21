-- Selective posture is not implemented; the coordinator treats it as closed.
ALTER TABLE "tenants" ALTER COLUMN "federation_posture" SET DEFAULT 'closed';--> statement-breakpoint
UPDATE "tenants" SET "federation_posture" = 'closed' WHERE "federation_posture" = 'selective';
