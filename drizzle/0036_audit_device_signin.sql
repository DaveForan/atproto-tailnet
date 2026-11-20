-- A specific audit action for an approved interactive device sign-in (ADR-0032).
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'device_signin_approved';
