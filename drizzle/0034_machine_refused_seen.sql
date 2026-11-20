-- Watermark for notifications about machines refused by a machine lock (ADR-0035).
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "machine_refused_seen_at" timestamp;
