-- Remote MCP server (/mcp) with OAuth 2.1: dynamically registered public
-- clients, per-user grants (one per consent), and hashed access/refresh tokens
-- bound to the grant's user, client and resource. Grants/revocations are
-- audited as instance-level rows (tenant_id NULL).
CREATE TABLE IF NOT EXISTS "mcp_oauth_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"client_name" text,
	"redirect_uris" jsonb NOT NULL,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_oauth_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id"),
	"client_id" text NOT NULL REFERENCES "mcp_oauth_clients"("id") ON DELETE CASCADE,
	"resource" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp,
	"revoked_at" timestamp
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_oauth_grants_user_idx" ON "mcp_oauth_grants" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_oauth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL REFERENCES "mcp_oauth_grants"("id") ON DELETE CASCADE,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL UNIQUE,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"rotated_at" timestamp,
	"revoked_at" timestamp
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_oauth_tokens_grant_idx" ON "mcp_oauth_tokens" USING btree ("grant_id");--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'mcp_grant_created';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'mcp_grant_revoked';
