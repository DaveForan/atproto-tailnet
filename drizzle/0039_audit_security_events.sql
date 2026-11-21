-- Audit actions for account security events (instance-level rows have no tenant).
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'sign_in_succeeded';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'sign_in_failed';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'trusted_device_added';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'trusted_device_removed';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'trusted_device_approved';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'recovery_codes_generated';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'recovery_code_used';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'step_up_refused';
