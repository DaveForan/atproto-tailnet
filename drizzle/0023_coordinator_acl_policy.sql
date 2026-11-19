-- Coordinator keeps ACL policies in memory; the service stores the last accepted
-- policy so it can replay it after a coordinator restart.
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "coordinator_acl_policy" jsonb;
