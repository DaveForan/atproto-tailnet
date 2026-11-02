CREATE TYPE "public"."federation_status" AS ENUM('pending', 'active', 'rejected', 'revoked');--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'federation_requested';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'federation_accepted';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'federation_rejected';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'federation_revoked';--> statement-breakpoint
CREATE TABLE "federation_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requester_tenant_id" uuid NOT NULL,
	"target_tenant_id" uuid NOT NULL,
	"status" "federation_status" DEFAULT 'pending' NOT NULL,
	"message" text,
	"requester_cidrs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"target_cidrs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reviewed_by_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "federation_links" ADD CONSTRAINT "federation_links_requester_tenant_id_tenants_id_fk" FOREIGN KEY ("requester_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_links" ADD CONSTRAINT "federation_links_target_tenant_id_tenants_id_fk" FOREIGN KEY ("target_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_links" ADD CONSTRAINT "federation_links_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_links_requester_idx" ON "federation_links" USING btree ("requester_tenant_id");--> statement-breakpoint
CREATE INDEX "federation_links_target_idx" ON "federation_links" USING btree ("target_tenant_id");