CREATE TYPE "public"."agent_token_status" AS ENUM('active', 'revoked');--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'agent_token_created';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'agent_token_revoked';--> statement-breakpoint
CREATE TABLE "agent_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "agent_token_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp,
	CONSTRAINT "agent_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "allow_agent_tokens" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "allow_member_agent_tokens" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_tokens" ADD CONSTRAINT "agent_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tokens" ADD CONSTRAINT "agent_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_tokens_tenant_idx" ON "agent_tokens" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "agent_tokens_hash_idx" ON "agent_tokens" USING btree ("token_hash");