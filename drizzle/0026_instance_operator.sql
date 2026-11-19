-- Instance operators (OPERATOR_DIDS): invite-only instance, instance settings
-- singleton, designated tailnet creators, operator suspension of tenants and
-- disabling of users. Operator actions not tied to a tenant are audited with a
-- NULL tenant_id.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "disabled_at" timestamp;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "suspended" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_logs" ALTER COLUMN "tenant_id" DROP NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "instance_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL CHECK ("id" = 1),
	"single_tailnet" boolean DEFAULT false NOT NULL,
	"default_tailnet_id" uuid REFERENCES "tenants"("id") ON DELETE SET NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
INSERT INTO "instance_settings" ("id") VALUES (1) ON CONFLICT DO NOTHING;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tailnet_creators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"did" text NOT NULL UNIQUE,
	"handle" text,
	"added_by_user_id" uuid NOT NULL REFERENCES "users"("id"),
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'operator_settings_updated';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'tailnet_creator_added';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'tailnet_creator_removed';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'tenant_suspended';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'tenant_unsuspended';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'tenant_deleted_by_operator';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'user_disabled';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'user_enabled';
