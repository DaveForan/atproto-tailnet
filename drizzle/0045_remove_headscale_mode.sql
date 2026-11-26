-- The Headscale mode is removed (ADR-0040). The coordinator is the only control plane.
-- This drops what only that mode used. Tailnets, members and devices are not changed.
DROP TABLE IF EXISTS "device_approvals";--> statement-breakpoint
DROP TABLE IF EXISTS "device_locks";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."device_approval_status";--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "port";--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "api_key";--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "container_id";--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "embedded_derp_enabled";--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "hibernate_after_days";--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "last_activity_at";--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "ip_allocation";--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "plan_name";--> statement-breakpoint
ALTER TABLE "auth_keys" DROP COLUMN IF EXISTS "hs_username";--> statement-breakpoint
ALTER TABLE "relay_nodes" RENAME COLUMN "headscale_node_id" TO "control_node_id";--> statement-breakpoint
ALTER TABLE "tenants" ALTER COLUMN "access_mode" SET DEFAULT 'member';--> statement-breakpoint
-- A tailnet cannot be stopped any more: its tenant in the coordinator always runs.
UPDATE "tenants" SET "status" = 'running' WHERE "status" = 'stopped';--> statement-breakpoint
ALTER TABLE "tenants" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TYPE "public"."tenant_status" RENAME TO "tenant_status_old";--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('provisioning', 'running', 'error', 'deleted');--> statement-breakpoint
ALTER TABLE "tenants" ALTER COLUMN "status" TYPE "public"."tenant_status" USING "status"::text::"public"."tenant_status";--> statement-breakpoint
ALTER TABLE "tenants" ALTER COLUMN "status" SET DEFAULT 'provisioning';--> statement-breakpoint
DROP TYPE "public"."tenant_status_old";--> statement-breakpoint
-- The permission to set Headscale device locks is gone.
UPDATE "roles" SET "permissions" = "permissions" - 'lock_devices' WHERE "permissions" ? 'lock_devices';--> statement-breakpoint
UPDATE "agent_tokens" SET "permissions" = "permissions" - 'lock_devices' WHERE "permissions" ? 'lock_devices';
