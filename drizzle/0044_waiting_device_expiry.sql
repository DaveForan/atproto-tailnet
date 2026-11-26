-- Devices that wait for admission expire (ADR-0039): the limit per tailnet, and when each wait began.
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "waiting_device_hours" integer DEFAULT 168 NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "waiting_devices" (
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
	"node_id" text NOT NULL,
	"owner_id" text,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "waiting_devices_tenant_id_node_id_pk" PRIMARY KEY("tenant_id","node_id")
);--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'device_expired';
