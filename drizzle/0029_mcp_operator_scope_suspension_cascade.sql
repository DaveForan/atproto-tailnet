-- MCP grants: explicit instance-operator scope (opt-in checkbox at consent,
-- operators only). Existing grants get no operator powers.
ALTER TABLE "mcp_oauth_grants" ADD COLUMN IF NOT EXISTS "operator" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Suspension cascade: a tenant suspended because an ancestor was suspended
-- records that ancestor; unsuspending it restores exactly those tenants.
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "suspended_by_parent_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenants_suspended_by_parent_idx" ON "tenants" USING btree ("suspended_by_parent_id");
