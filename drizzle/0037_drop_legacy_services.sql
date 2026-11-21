-- Legacy tables, enums and memberships.role that no code reads or writes.
DROP TABLE IF EXISTS "board_posts";--> statement-breakpoint
DROP TABLE IF EXISTS "services";--> statement-breakpoint
DROP TABLE IF EXISTS "service_devices";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."board_post_status";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."service_status";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."service_device_status";--> statement-breakpoint
ALTER TABLE "memberships" DROP COLUMN IF EXISTS "role";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."member_role";
