-- Device visibility and consensual sharing (ADR-0036).
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "access_mode" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "controller_board_text" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
	"author_id" uuid NOT NULL REFERENCES "users"("id"),
	"board" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"name" text,
	"node_id" text NOT NULL,
	"proto" text DEFAULT 'tcp' NOT NULL,
	"port" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reject_reason" text,
	"reviewed_by_id" uuid REFERENCES "users"("id"),
	"reviewed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "service_posts_board_chk" CHECK ("board" IN ('public', 'private')),
	CONSTRAINT "service_posts_status_chk" CHECK ("status" IN ('pending', 'approved', 'rejected', 'removed')),
	CONSTRAINT "service_posts_proto_chk" CHECK ("proto" IN ('tcp', 'udp')),
	CONSTRAINT "service_posts_port_chk" CHECK ("port" BETWEEN 1 AND 65535)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_posts_tenant_idx" ON "service_posts" USING btree ("tenant_id", "board", "status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_posts_author_idx" ON "service_posts" USING btree ("author_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "service_posts_private_name_idx" ON "service_posts" USING btree ("tenant_id", "author_id", "name") WHERE "board" = 'private' AND "status" <> 'removed';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "service_posts_public_name_idx" ON "service_posts" USING btree ("tenant_id", "name") WHERE "board" = 'public' AND "status" <> 'removed' AND "name" IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL REFERENCES "service_posts"("id") ON DELETE cascade,
	"user_id" uuid NOT NULL REFERENCES "users"("id"),
	"node_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "service_connections_post_node_idx" ON "service_connections" USING btree ("post_id", "node_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_connections_user_idx" ON "service_connections" USING btree ("user_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "friendships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
	"requester_id" uuid NOT NULL REFERENCES "users"("id"),
	"addressee_id" uuid NOT NULL REFERENCES "users"("id"),
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"responded_at" timestamp,
	CONSTRAINT "friendships_status_chk" CHECK ("status" IN ('pending', 'accepted')),
	CONSTRAINT "friendships_not_self_chk" CHECK ("requester_id" <> "addressee_id")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "friendships_pair_idx" ON "friendships" USING btree ("tenant_id", LEAST("requester_id", "addressee_id"), GREATEST("requester_id", "addressee_id"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "friendships_addressee_idx" ON "friendships" USING btree ("addressee_id", "status");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "member_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
	"blocker_id" uuid NOT NULL REFERENCES "users"("id"),
	"blocked_id" uuid NOT NULL REFERENCES "users"("id"),
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "member_blocks_pair_idx" ON "member_blocks" USING btree ("tenant_id", "blocker_id", "blocked_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "device_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
	"owner_id" uuid NOT NULL REFERENCES "users"("id"),
	"guest_id" uuid NOT NULL REFERENCES "users"("id"),
	"owner_node_id" text NOT NULL,
	"ports" jsonb NOT NULL,
	"guest_node_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"accepted_at" timestamp,
	"ended_at" timestamp,
	CONSTRAINT "device_shares_status_chk" CHECK ("status" IN ('requested', 'offered', 'active', 'ended')),
	CONSTRAINT "device_shares_not_self_chk" CHECK ("owner_id" <> "guest_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_shares_tenant_idx" ON "device_shares" USING btree ("tenant_id", "status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_shares_owner_idx" ON "device_shares" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_shares_guest_idx" ON "device_shares" USING btree ("guest_id");
