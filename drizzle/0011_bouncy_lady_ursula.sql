ALTER TYPE "public"."audit_action" ADD VALUE 'derp_updated';--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "custom_derp_regions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "embedded_derp_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "use_public_derp" boolean DEFAULT true NOT NULL;