-- Cross-instance federation (ADR-0019): a durable per-link outbox for signed
-- LINK_* messages awaiting delivery to the peer's broker, and a flag recording
-- that a link ended with a permanent revocation (never re-handshaked).
ALTER TABLE "federation_links" ADD COLUMN IF NOT EXISTS "revoked_permanently" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "federation_links" ADD COLUMN IF NOT EXISTS "outbox" jsonb;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "federation_links_outbox_idx" ON "federation_links" USING btree ("id") WHERE "outbox" IS NOT NULL;
