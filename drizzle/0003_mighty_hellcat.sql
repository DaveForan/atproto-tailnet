ALTER TYPE "public"."audit_action" ADD VALUE 'role_created';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'role_updated';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'role_deleted';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'member_role_changed';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'default_role_changed';--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "role_id" uuid;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "is_originator" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "default_role_id" uuid;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "roles_tenant_name_idx" ON "roles" USING btree ("tenant_id","name");--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;