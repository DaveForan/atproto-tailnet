CREATE TABLE IF NOT EXISTS "service_auth_jti_cache" (
  "jti" text PRIMARY KEY NOT NULL,
  "issuer_did" text NOT NULL,
  "audience_did" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "service_auth_jti_expires_idx" ON "service_auth_jti_cache" ("expires_at");
