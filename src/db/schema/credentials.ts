/** Verifiable credential state: revocations, holder-binding challenges and the service-auth replay cache. */

import { pgTable, uuid, text, timestamp, boolean, uniqueIndex, index } from "drizzle-orm/pg-core";
import { tenants } from "./tenancy.js";

export const credentialRevocations = pgTable(
  "credential_revocations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** The credential's `jti`. It is unique only per issuer. */
    credentialId: text("credential_id").notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    issuerDid: text("issuer_did").notNull(),
    reason: text("reason"),
    revokedAt: timestamp("revoked_at").defaultNow().notNull(),
  },
  (t) => [
    index("cred_revocations_cred_idx").on(t.credentialId),
    uniqueIndex("cred_revocations_issuer_cred_idx").on(t.issuerDid, t.credentialId),
  ],
);

export const holderBindingChallenges = pgTable(
  "holder_binding_challenges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    nonce: text("nonce").notNull().unique(),
    holderDid: text("holder_did"),
    expiresAt: timestamp("expires_at").notNull(),
    consumed: boolean("consumed").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("holder_challenges_nonce_idx").on(t.nonce)],
);

export const serviceAuthJtiCache = pgTable(
  "service_auth_jti_cache",
  {
    jti: text("jti").primaryKey(),
    issuerDid: text("issuer_did").notNull(),
    audienceDid: text("audience_did").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("service_auth_jti_expires_idx").on(t.expiresAt)],
);
