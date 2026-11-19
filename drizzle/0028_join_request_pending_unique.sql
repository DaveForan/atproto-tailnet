-- One pending join request per (tenant, requester). Older duplicates (from
-- before the constraint) are collapsed to the earliest pending row.
DELETE FROM "join_requests" jr
USING "join_requests" keep
WHERE jr."status" = 'pending'
  AND keep."status" = 'pending'
  AND jr."tenant_id" = keep."tenant_id"
  AND jr."requester_id" = keep."requester_id"
  AND (jr."requested_at", jr."id") > (keep."requested_at", keep."id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "join_requests_pending_uq" ON "join_requests" ("tenant_id", "requester_id") WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "join_requests_tenant_requester_idx" ON "join_requests" ("tenant_id", "requester_id", "requested_at");
