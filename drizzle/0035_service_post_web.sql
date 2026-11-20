-- Service posts that are web applications behind the gateway (ADR-0030).
ALTER TABLE "service_posts" ADD COLUMN IF NOT EXISTS "web" boolean DEFAULT false NOT NULL;
