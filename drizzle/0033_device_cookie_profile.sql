-- Device cookie and profile for trusted devices (ADR-0035).
ALTER TABLE "trusted_devices" ADD COLUMN IF NOT EXISTS "cookie_hash" text;--> statement-breakpoint
ALTER TABLE "trusted_devices" ADD COLUMN IF NOT EXISTS "profile" jsonb;--> statement-breakpoint
ALTER TABLE "trusted_devices" ADD COLUMN IF NOT EXISTS "profile_warning" text;--> statement-breakpoint
ALTER TABLE "trusted_devices" ADD COLUMN IF NOT EXISTS "profile_warning_at" timestamp;--> statement-breakpoint
ALTER TABLE "device_trust_requests" ADD COLUMN IF NOT EXISTS "cookie_hash" text;--> statement-breakpoint
ALTER TABLE "device_trust_requests" ADD COLUMN IF NOT EXISTS "profile" jsonb;
