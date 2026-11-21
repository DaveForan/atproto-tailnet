-- Roles that may connect to a public service post (ADR-0030). Empty = every member.
ALTER TABLE "service_posts" ADD COLUMN IF NOT EXISTS "allowed_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
