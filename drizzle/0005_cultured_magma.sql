CREATE TYPE "public"."board_post_status" AS ENUM('active', 'removed');--> statement-breakpoint
CREATE TYPE "public"."service_device_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."service_status" AS ENUM('pending', 'active', 'disabled');--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'board_enabled';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'board_disabled';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'board_settings_updated';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'board_post_created';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'board_post_removed';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'service_device_requested';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'service_device_approved';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'service_device_rejected';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'service_device_removed';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'service_created';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'service_approved';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'service_rejected';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'service_removed';--> statement-breakpoint
CREATE TABLE "board_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" "board_post_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" "service_device_status" DEFAULT 'pending' NOT NULL,
	"hs_username" text,
	"pre_auth_key" text,
	"command" text,
	"reviewed_by_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"reviewed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"service_device_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"url" text NOT NULL,
	"status" "service_status" DEFAULT 'pending' NOT NULL,
	"reviewed_by_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "board_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "max_board_posts" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "max_board_posts_displayed" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "require_service_approval" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "require_service_device_approval" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "board_posts" ADD CONSTRAINT "board_posts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_posts" ADD CONSTRAINT "board_posts_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_posts" ADD CONSTRAINT "board_posts_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_devices" ADD CONSTRAINT "service_devices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_devices" ADD CONSTRAINT "service_devices_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_devices" ADD CONSTRAINT "service_devices_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_service_device_id_service_devices_id_fk" FOREIGN KEY ("service_device_id") REFERENCES "public"."service_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;