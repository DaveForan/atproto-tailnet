ALTER TYPE "public"."audit_action" ADD VALUE 'tenant_hibernated' BEFORE 'acl_updated';--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "hibernate_after_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "last_activity_at" timestamp DEFAULT now() NOT NULL;