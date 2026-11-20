-- Device-bound access (ADR-0035): trusted devices, recovery codes, and
-- requests of a new device to become trusted.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "max_trusted_devices" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trusted_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"name" text NOT NULL,
	"kind" text DEFAULT 'device-key' NOT NULL,
	"public_key_jwk" jsonb NOT NULL,
	"user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trusted_devices_user_idx" ON "trusted_devices" USING btree ("user_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"code_hash" text NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recovery_codes_user_idx" ON "recovery_codes" USING btree ("user_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "device_trust_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"name" text NOT NULL,
	"public_key_jwk" jsonb NOT NULL,
	"user_agent" text,
	"code" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "device_trust_requests_status_chk" CHECK ("status" IN ('pending', 'approved', 'denied'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_trust_requests_user_idx" ON "device_trust_requests" USING btree ("user_id", "status");
