ALTER TYPE "public"."audit_action" ADD VALUE 'sub_collective_created';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'sub_collective_detached';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'sub_collective_ejected';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'floor_policy_updated';--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "path" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "depth" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "max_sub_collectives" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "floor_policies" jsonb;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_parent_id_tenants_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;