-- Credential ids (jti) are unique per issuer, not globally: one collective's
-- revocation must never shadow another issuer's credential with the same id.
ALTER TABLE "credential_revocations" DROP CONSTRAINT IF EXISTS "credential_revocations_credential_id_unique";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cred_revocations_issuer_cred_idx" ON "credential_revocations" USING btree ("issuer_did","credential_id");
