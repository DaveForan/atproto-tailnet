ALTER TYPE "public"."audit_action" ADD VALUE 'ip_config_updated';--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "ipv4_prefix" text DEFAULT '100.64.0.0/10' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "ipv6_prefix" text DEFAULT 'fd7a:115c:a1e0::/48' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "ip_allocation" text DEFAULT 'sequential' NOT NULL;