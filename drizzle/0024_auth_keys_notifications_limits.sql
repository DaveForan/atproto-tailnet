-- Issued pre-auth keys (both control-plane modes): listed and revocable from
-- the dashboard; the secret key itself is never stored.
CREATE TABLE IF NOT EXISTS "auth_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
	"user_id" uuid NOT NULL REFERENCES "users"("id"),
	"control_key_id" text,
	"prefix" text NOT NULL,
	"hs_username" text,
	"kind" text DEFAULT 'device' NOT NULL,
	"reusable" boolean DEFAULT false NOT NULL,
	"ephemeral" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_keys_tenant_created_idx" ON "auth_keys" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_keys_tenant_user_idx" ON "auth_keys" USING btree ("tenant_id","user_id");--> statement-breakpoint
-- Dashboard notifications, one row per recipient.
CREATE TABLE IF NOT EXISTS "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
	"user_id" uuid NOT NULL REFERENCES "users"("id"),
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"link" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"read_at" timestamp
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_tenant_created_idx" ON "notifications" USING btree ("user_id","tenant_id","created_at");--> statement-breakpoint
-- Per-tenant notification webhook (secret is write-only via the API).
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "notification_webhook_url" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "notification_webhook_secret" text;--> statement-breakpoint
-- Coordinator mode: route auto-approvers, replayed after a coordinator restart.
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "coordinator_auto_approvers" jsonb;--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'auth_key_revoked';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'limits_updated';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'notification_settings_updated';
