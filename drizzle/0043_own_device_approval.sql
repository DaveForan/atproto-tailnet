-- A member's own choice to admit each of their new devices (ADR-0039), and the audit actions around it.
ALTER TABLE "memberships" ADD COLUMN IF NOT EXISTS "approve_own_devices" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'own_device_approval_changed';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'devices_invalidated';
