/** Device-bound sign-in (ADR-0035): trusted browsers, recovery codes and trust requests. */

import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { users } from "./tenancy.js";

/** A browser the user trusts for sign-in. Only its public key is stored. */
export const trustedDevices = pgTable(
  "trusted_devices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** "device-key": a non-extractable WebCrypto ECDSA P-256 key. */
    kind: text("kind").notNull().default("device-key"),
    publicKeyJwk: jsonb("public_key_jwk").notNull().$type<{ kty: string; crv: string; x: string; y: string }>(),
    /** Shown to the user. Information only. */
    userAgent: text("user_agent"),
    /** SHA-256 of the HttpOnly device cookie. A proof needs the key and the cookie. */
    cookieHash: text("cookie_hash"),
    /** Browser traits at enrolment. A different-looking sign-in raises a warning. */
    profile: jsonb("profile").$type<Record<string, string>>(),
    profileWarning: text("profile_warning"),
    profileWarningAt: timestamp("profile_warning_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at"),
  },
  (t) => [index("trusted_devices_user_idx").on(t.userId)],
);

/** Single-use recovery codes. Only SHA-256 hashes are stored. */
export const recoveryCodes = pgTable(
  "recovery_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("recovery_codes_user_idx").on(t.userId)],
);

/** A new browser asking to become trusted. The user confirms its code on a trusted device. */
export const deviceTrustRequests = pgTable(
  "device_trust_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    publicKeyJwk: jsonb("public_key_jwk").notNull().$type<{ kty: string; crv: string; x: string; y: string }>(),
    userAgent: text("user_agent"),
    cookieHash: text("cookie_hash"),
    profile: jsonb("profile").$type<Record<string, string>>(),
    code: text("code").notNull(),
    status: text("status").notNull().$type<"pending" | "approved" | "denied">().default("pending"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (t) => [index("device_trust_requests_user_idx").on(t.userId, t.status)],
);
