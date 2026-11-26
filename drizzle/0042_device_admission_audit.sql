-- Audit actions for the admission of a new device (ADR-0039).
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'device_admitted_by_owner';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'device_admitted';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'device_refused';
