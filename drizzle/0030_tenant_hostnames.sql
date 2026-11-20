-- Public tailnet addresses (<slug>.<BASE_DOMAIN>). tenants.slug stays the
-- permanent internal id; these rows are routed by Caddy and handed to new
-- devices. One live primary per tenant; older names remain as aliases.
CREATE TABLE IF NOT EXISTS "tenant_hostnames" (
	"slug" text PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"retired_at" timestamp
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_hostnames" ADD CONSTRAINT "tenant_hostnames_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_hostnames_tenant_idx" ON "tenant_hostnames" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_hostnames_one_primary_idx" ON "tenant_hostnames" USING btree ("tenant_id") WHERE "tenant_hostnames"."is_primary" AND "tenant_hostnames"."retired_at" IS NULL;--> statement-breakpoint
-- Backfill: every existing tenant's slug becomes its primary address (deleted
-- tenants keep theirs reserved, as before).
INSERT INTO "tenant_hostnames" ("slug", "tenant_id", "is_primary")
SELECT "slug", "id", true FROM "tenants"
ON CONFLICT ("slug") DO NOTHING;
